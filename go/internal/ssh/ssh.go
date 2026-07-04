// Package ssh abstracts how the CLI connects editors and shells to remote
// sandboxes over SSH: minting connection details from the API, generating a
// stable per-sandbox host alias in ~/.ssh/amika.conf, and execing ssh.
package ssh

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"os/signal"
	"strings"
	"syscall"

	"github.com/gofixpoint/amika/go/internal/apiclient"
)

// ExecSSH replaces the current process with an interactive ssh session to the
// named sandbox. It fetches fresh connection details from the API and execs the
// system ssh binary directly, forwarding any extra args (e.g. a remote command).
func ExecSSH(client *apiclient.Client, name string, forcePTY bool, extraArgs []string) error {
	info, err := client.GetSSH(name)
	if err != nil {
		return err
	}
	if info.SSHDestination == "" {
		return fmt.Errorf("server returned empty SSH destination")
	}

	// Providers whose SSH is tunneled over a WebSocket (Vercel) have no routable
	// host: connect through a local `websocat` ProxyCommand using the minted key.
	if info.WebSocketProxyURL != "" {
		return execTunneledSSH(info, forcePTY, extraArgs)
	}

	sshArgs := strings.Fields(info.SSHDestination)

	if forcePTY {
		dest := sshArgs[len(sshArgs)-1]
		sshArgs = append(sshArgs[:len(sshArgs)-1], "-t", dest)
	}

	if len(extraArgs) > 0 {
		sshArgs = append(sshArgs, extraArgs...)
	}

	sshBin, err := exec.LookPath("ssh")
	if err != nil {
		return fmt.Errorf("ssh not found: %w", err)
	}
	return syscall.Exec(sshBin, append([]string{"ssh"}, sshArgs...), os.Environ())
}

// execTunneledSSH connects to a sandbox whose sshd is only reachable through a
// WebSocket bridge (Vercel). There is no routable host, so ssh dials the bridge
// via a local `websocat` ProxyCommand and authenticates with the minted PEM key.
// Unlike the direct path this does NOT `syscall.Exec` (which never returns), so
// the temporary key file can be cleaned up after the interactive session ends.
func execTunneledSSH(info *apiclient.SSHInfo, forcePTY bool, extraArgs []string) error {
	if info.PrivateKey == "" {
		return fmt.Errorf("server returned a WebSocket SSH proxy URL but no private key")
	}
	if _, err := exec.LookPath("websocat"); err != nil {
		return fmt.Errorf("websocat is required to connect to this sandbox's SSH tunnel but was not found on PATH; install it from https://github.com/vi/websocat")
	}
	sshBin, err := exec.LookPath("ssh")
	if err != nil {
		return fmt.Errorf("ssh not found: %w", err)
	}

	keyPath, cleanup, err := writeTempIdentity(info.PrivateKey)
	if err != nil {
		return err
	}
	defer cleanup()

	sshArgs, err := tunnelSSHArgs(info, keyPath, forcePTY)
	if err != nil {
		return err
	}
	sshArgs = append(sshArgs, extraArgs...)

	// A Ctrl-C on a non-interactive tunneled command (no PTY, so the terminal is
	// in cooked mode) delivers SIGINT to our whole process group: ssh, our child,
	// gets it and exits. Without trapping it here the default action would kill
	// this wrapper first, skipping the deferred cleanup and leaking the minted
	// PEM key into /tmp. Trap SIGINT/SIGTERM so we stay alive until c.Run returns
	// (letting the deferred cleanup run) and remove the key eagerly in case we're
	// killed anyway. We do NOT forward the signal to ssh: it already received the
	// group signal, and an interactive session puts the terminal in raw mode
	// (Ctrl-C is delivered to the remote, not to us), so we must never tear that
	// session down ourselves.
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, os.Interrupt, syscall.SIGTERM)
	defer signal.Stop(sigCh)
	go func() {
		for range sigCh {
			cleanup()
		}
	}()

	c := exec.Command(sshBin, sshArgs...)
	c.Stdin, c.Stdout, c.Stderr = os.Stdin, os.Stdout, os.Stderr
	runErr := c.Run()

	// Preserve ssh's own exit status the way the direct syscall.Exec path does,
	// so a remote command's exit code (2, 127, 130, …) survives instead of being
	// collapsed into Cobra's generic exit 1. os.Exit skips deferred funcs, so
	// remove the key first.
	var exitErr *exec.ExitError
	if errors.As(runErr, &exitErr) {
		cleanup()
		os.Exit(exitErr.ExitCode())
	}
	return runErr
}

// tunnelSSHArgs builds the `ssh` arguments for a WebSocket-tunneled sandbox: an
// identity file, a `websocat` ProxyCommand to the wss URL, and the parsed
// user@host from the (non-routable) destination label. Host-key checking is set
// to accept-new against /dev/null because each sandbox is ephemeral and the
// "host" is only a label.
func tunnelSSHArgs(info *apiclient.SSHInfo, keyPath string, forcePTY bool) ([]string, error) {
	d, err := ParseDestination(info.SSHDestination)
	if err != nil {
		return nil, err
	}
	dest := d.Host
	if d.User != "" {
		dest = d.User + "@" + d.Host
	}
	args := []string{
		"-i", keyPath,
		"-o", "IdentitiesOnly=yes",
		"-o", "StrictHostKeyChecking=accept-new",
		"-o", "UserKnownHostsFile=/dev/null",
		"-o", "ProxyCommand=" + proxyCommand(info.WebSocketProxyURL),
	}
	if forcePTY {
		args = append(args, "-t")
	}
	return append(args, dest), nil
}

// proxyCommand builds the ssh ProxyCommand that bridges to the sandbox's sshd
// over the WebSocket. ssh executes ProxyCommand through the user's shell, after
// first expanding its own `%` tokens, so a signed wss URL — which routinely
// contains `%2F`, `&`, `?`, etc. — must be both shell-quoted (so the shell
// treats it literally) and have every `%` doubled (so ssh's token pass leaves a
// single literal `%`). Skipping either silently breaks the tunnel.
func proxyCommand(wsURL string) string {
	quoted := shellQuote(wsURL)
	escaped := strings.ReplaceAll(quoted, "%", "%%")
	return "websocat --binary - " + escaped
}

// shellQuote wraps s in single quotes so /bin/sh treats every character
// literally, escaping any embedded single quote by ending the quoted run,
// inserting an escaped quote, and reopening it. Used for values interpolated
// into ssh's shell-executed ProxyCommand.
func shellQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}

// writeTempIdentity writes a PEM private key to a fresh 0600 temp file and
// returns its path plus a cleanup func. ssh requires the key to end with a
// newline, so one is appended if absent.
func writeTempIdentity(pem string) (string, func(), error) {
	f, err := os.CreateTemp("", "amika-ssh-*.key")
	if err != nil {
		return "", nil, fmt.Errorf("create temp identity file: %w", err)
	}
	name := f.Name()
	cleanup := func() { _ = os.Remove(name) }
	if err := f.Chmod(0o600); err != nil {
		f.Close()
		cleanup()
		return "", nil, fmt.Errorf("chmod identity file: %w", err)
	}
	if !strings.HasSuffix(pem, "\n") {
		pem += "\n"
	}
	if _, err := f.WriteString(pem); err != nil {
		f.Close()
		cleanup()
		return "", nil, fmt.Errorf("write identity file: %w", err)
	}
	if err := f.Close(); err != nil {
		cleanup()
		return "", nil, fmt.Errorf("close identity file: %w", err)
	}
	return name, cleanup, nil
}

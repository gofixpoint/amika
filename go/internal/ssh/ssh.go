// Package ssh abstracts how the CLI connects editors and shells to remote
// sandboxes over SSH: minting connection details from the API, generating a
// stable per-sandbox host alias in ~/.ssh/amika.conf, and execing ssh.
package ssh

import (
	"fmt"
	"io"
	"os"
	"os/exec"
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

// DispatchSSH runs a one-off ssh command against the sandbox as a child process
// (no process replacement, no PTY) and returns once it completes, wiring its
// output to stdout/stderr. Unlike ExecSSH it hands control back to the caller,
// so callers can act on the result afterward (e.g. emit a JSON envelope only
// after the dispatch has actually succeeded). All the failure-prone setup
// (fetching connection details, resolving the ssh binary) happens before the
// process runs, so a failure is reported instead of leaving a half-done state.
func DispatchSSH(client *apiclient.Client, name string, extraArgs []string, stdout, stderr io.Writer) error {
	info, err := client.GetSSH(name)
	if err != nil {
		return err
	}
	if info.SSHDestination == "" {
		return fmt.Errorf("server returned empty SSH destination")
	}

	sshArgs := strings.Fields(info.SSHDestination)
	if len(extraArgs) > 0 {
		sshArgs = append(sshArgs, extraArgs...)
	}

	sshBin, err := exec.LookPath("ssh")
	if err != nil {
		return fmt.Errorf("ssh not found: %w", err)
	}

	cmd := exec.Command(sshBin, sshArgs...)
	cmd.Stdout = stdout
	cmd.Stderr = stderr
	return cmd.Run()
}

// BuildSessionSSHArgv assembles the argv for the system ssh binary from the
// arguments forwarded to it, swapping the sandbox name at nameIdx for the
// managed v2 alias. Substituting in place rather than prepending the alias
// preserves ssh's own grammar, "ssh [options] destination [command]": options
// written before the sandbox name stay before the destination, where ssh reads
// them as client options, and anything after it stays after, where ssh reads it
// as the remote command.
func BuildSessionSSHArgv(forward []string, nameIdx int, alias string) []string {
	argv := make([]string, 0, len(forward))
	argv = append(argv, forward[:nameIdx]...)
	argv = append(argv, alias)
	argv = append(argv, forward[nameIdx+1:]...)
	return argv
}

// ExecSessionSSH replaces the current process with OpenSSH targeting a strict
// v2 alias whose ProxyCommand fetches a fresh session per dial. argv is the
// complete ssh argument list, as built by BuildSessionSSHArgv.
func ExecSessionSSH(alias string, argv []string) error {
	if _, err := ParseSessionAlias(alias); err != nil {
		return err
	}
	sshBin, err := exec.LookPath("ssh")
	if err != nil {
		return fmt.Errorf("ssh not found: %w", err)
	}
	return syscall.Exec(sshBin, append([]string{"ssh"}, argv...), os.Environ())
}

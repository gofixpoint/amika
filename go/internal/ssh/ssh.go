// Package ssh abstracts how the CLI connects editors and shells to remote
// sandboxes over SSH: minting connection details from the API, generating a
// stable per-sandbox host alias in ~/.ssh/amika.conf, and execing ssh.
package ssh

import (
	"fmt"
	"os"
	"os/exec"
	"strings"
	"syscall"

	"github.com/gofixpoint/amika/go/internal/apiclient"
	"github.com/gofixpoint/amika/go/internal/basedir"
)

// InfoClient is the subset of apiclient.Client needed to resolve a sandbox's
// managed SSH host: its rotating connection details plus, as a fallback, its
// immutable id.
type InfoClient interface {
	GetSSH(name string) (*apiclient.SSHInfo, error)
	GetSandbox(name string) (*apiclient.RemoteSandbox, error)
}

// ResolveHost fetches fresh SSH connection details for a sandbox, records (or
// refreshes) its managed entry in ~/.ssh/amika.conf, ensures ~/.ssh/config
// includes that file, and returns the stable alias to connect through, the raw
// info, and any extra ssh options the server included beyond user/host/port.
// Connecting via the alias (rather than the raw destination) is what applies
// `StrictHostKeyChecking accept-new`, so callers avoid a "Host key verification
// failed" error on first connect to a fresh host. The alias block cannot carry
// options such as -i or -o ProxyCommand, so a caller execing ssh must forward
// the returned options on the command line.
func ResolveHost(client InfoClient, paths basedir.Paths, name string) (string, *apiclient.SSHInfo, []string, error) {
	info, err := client.GetSSH(name)
	if err != nil {
		return "", nil, nil, err
	}
	if info.SSHDestination == "" {
		return "", nil, nil, fmt.Errorf("server returned empty SSH destination")
	}

	sandboxID := info.SandboxID
	sandboxName := info.SandboxName
	if sandboxID == "" {
		sb, err := client.GetSandbox(name)
		if err != nil {
			return "", nil, nil, fmt.Errorf("look up sandbox id: %w", err)
		}
		sandboxID = sb.ID
		sandboxName = sb.Name
	}
	if sandboxName == "" {
		sandboxName = name
	}

	entry, options, err := NewHostEntry(sandboxID, sandboxName, info.SSHDestination, info.ExpiresAt)
	if err != nil {
		return "", nil, nil, err
	}
	// -F replaces (rather than supplements) the config file ssh reads, so
	// forwarding it would make ssh ignore the managed block we just wrote and
	// try to dial the literal alias as a host. It is fundamentally incompatible
	// with connecting through the alias, so reject it rather than silently fail
	// to connect. No current provider emits it; this guards a future one.
	if opt, ok := configFileOption(options); ok {
		return "", nil, nil, fmt.Errorf("server-provided SSH option %q selects an alternate config file, which is incompatible with amika's managed host alias", opt)
	}
	alias, err := UpsertHost(paths, entry)
	if err != nil {
		return "", nil, nil, fmt.Errorf("write managed SSH config: %w", err)
	}
	return alias, info, options, nil
}

// configFileOption reports whether options select an alternate ssh config file
// via -F — in any getopt spelling: "-F", attached "-Ffile", or bundled after
// boolean flags like "-4F" — and returns the offending token. It scans each
// option cluster the way consumesFollowingArg does rather than matching a "-F"
// prefix: a letter that itself takes an argument ends the cluster, so an 'F'
// after it belongs to that argument, not a config-file flag.
//
// -F replaces (rather than supplements) the config file ssh reads, so it is the
// one forwarded option that defeats alias resolution outright. Other options
// (e.g. -o) merge with the managed block; a hostile -o could still override an
// individual directive, but the destination comes from the trusted,
// authenticated API — the same trust the pre-existing scp forwarding assumes.
func configFileOption(options []string) (string, bool) {
	for _, opt := range options {
		if len(opt) < 2 || opt[0] != '-' || opt[1] == '-' {
			continue
		}
		for i := 1; i < len(opt); i++ {
			if opt[i] == 'F' {
				return opt, true
			}
			// A non-F option that consumes an argument ends the cluster; the
			// remainder of the token is its value, not further option letters.
			if strings.IndexByte(argTakingOptions, opt[i]) >= 0 {
				break
			}
		}
	}
	return "", false
}

// ExecSSH replaces the current process with an interactive ssh session to the
// named sandbox. It resolves the sandbox's managed host alias (writing the
// managed SSH config as a side effect) and execs the system ssh binary against
// that alias, forwarding any server-provided ssh options plus any extra args
// (e.g. a remote command).
func ExecSSH(client InfoClient, paths basedir.Paths, name string, forcePTY bool, extraArgs []string) error {
	alias, _, options, err := ResolveHost(client, paths, name)
	if err != nil {
		return err
	}

	sshArgs := buildSSHArgs(alias, options, forcePTY, extraArgs)

	sshBin, err := exec.LookPath("ssh")
	if err != nil {
		return fmt.Errorf("ssh not found: %w", err)
	}
	return syscall.Exec(sshBin, append([]string{"ssh"}, sshArgs...), os.Environ())
}

// buildSSHArgs assembles the argument list for `ssh <alias>`, placing the
// server-provided options and -t before the destination (as ssh requires) and
// any remote command after it. The alias supplies HostName/User/Port from the
// managed config; the options carry anything that block cannot express.
func buildSSHArgs(alias string, options []string, forcePTY bool, extraArgs []string) []string {
	var sshArgs []string
	sshArgs = append(sshArgs, options...)
	if forcePTY {
		sshArgs = append(sshArgs, "-t")
	}
	sshArgs = append(sshArgs, alias)
	sshArgs = append(sshArgs, extraArgs...)
	return sshArgs
}

// Package ssh abstracts how the CLI connects editors and shells to remote
// sandboxes over SSH: minting connection details from the API, generating a
// stable per-sandbox host alias in ~/.ssh/amika.conf, and execing ssh.
package ssh

import (
	"fmt"
	"os"
	"os/exec"
	"syscall"
)

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

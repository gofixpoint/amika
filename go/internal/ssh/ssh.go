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

package materialize

import (
	"bytes"
	"fmt"
	"os"
	"os/exec"
	"strings"
)

// Options contains the options for the materialize command.
// Exactly one of Script or Cmd must be set.
type Options struct {
	Script     string   // Path to the script to execute
	ScriptArgs []string // Arguments to pass to the script
	Cmd        string   // Bash command string to execute
	Workdir    string   // Working directory for script execution
	Outdir     string   // Directory where the script writes output files
	Destdir    string   // Host directory where output files are copied
	Env        []string // Extra environment variables (KEY=VALUE) for the child process
}

// Run executes a script or command and copies its output to the destination directory.
func Run(opts Options) error {
	hasScript := opts.Script != ""
	hasCmd := opts.Cmd != ""
	if hasScript == hasCmd {
		return fmt.Errorf("exactly one of Script or Cmd must be set")
	}

	// Create workdir if it doesn't exist
	if err := os.MkdirAll(opts.Workdir, 0755); err != nil {
		return fmt.Errorf("failed to create workdir: %w", err)
	}

	// Create outdir if it doesn't exist
	if err := os.MkdirAll(opts.Outdir, 0755); err != nil {
		return fmt.Errorf("failed to create outdir: %w", err)
	}

	// Create destdir if it doesn't exist
	if err := os.MkdirAll(opts.Destdir, 0755); err != nil {
		return fmt.Errorf("failed to create destdir: %w", err)
	}

	// Build the command based on execution mode
	var cmd *exec.Cmd
	if hasScript {
		// Validate script exists and is not a directory
		scriptInfo, err := os.Stat(opts.Script)
		if err != nil {
			if os.IsNotExist(err) {
				return fmt.Errorf("script does not exist: %s", opts.Script)
			}
			return fmt.Errorf("failed to stat script: %w", err)
		}
		if scriptInfo.IsDir() {
			return fmt.Errorf("script is a directory: %s", opts.Script)
		}

		cmd = exec.Command(opts.Script, opts.ScriptArgs...)
	} else {
		cmd = exec.Command("bash", "-c", opts.Cmd)
	}

	cmd.Dir = opts.Workdir
	if len(opts.Env) > 0 {
		cmd.Env = append(os.Environ(), opts.Env...)
	}
	cmd.Stdout = os.Stdout

	var stderrBuf bytes.Buffer
	cmd.Stderr = &stderrBuf

	// Print header before execution
	if hasScript {
		cmdLine := strings.Join(append([]string{opts.Script}, opts.ScriptArgs...), " ")
		fmt.Fprintf(os.Stderr, "Running script:\n\n> %s\n\n", cmdLine)
	} else {
		fmt.Fprintf(os.Stderr, "Running command:\n\n> %s\n\n", opts.Cmd)
	}

	if err := cmd.Run(); err != nil {
		label := "Script"
		if hasCmd {
			label = "Command"
		}
		captured := strings.TrimRight(stderrBuf.String(), "\n")
		if captured != "" {
			lines := strings.Split(captured, "\n")
			quoted := make([]string, len(lines))
			for i, line := range lines {
				quoted[i] = "> " + line
			}
			fmt.Fprintf(os.Stderr, "%s failed to run:\n\n%s\n\n", label, strings.Join(quoted, "\n"))
		} else {
			fmt.Fprintf(os.Stderr, "%s failed to run.\n", label)
		}
		return fmt.Errorf("execution failed: %w", err)
	}

	// On success, write captured stderr through so it's still visible
	if stderrBuf.Len() > 0 {
		stderrBuf.WriteTo(os.Stderr)
	}

	// Copy outdir contents to destdir using rsync
	rsyncCmd := exec.Command("rsync", "-a", opts.Outdir+"/", opts.Destdir+"/")
	rsyncCmd.Stdout = os.Stdout
	rsyncCmd.Stderr = os.Stderr
	if err := rsyncCmd.Run(); err != nil {
		return fmt.Errorf("failed to copy output files: %w", err)
	}

	return nil
}

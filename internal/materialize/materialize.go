package materialize

import (
	"fmt"
	"os"
	"os/exec"
)

// Options contains the options for the materialize command.
type Options struct {
	Script  string // Path to the script to execute
	Workdir string // Working directory for script execution
	Outdir  string // Directory where the script writes output files
	Destdir string // Host directory where output files are copied
}

// Run executes a script and copies its output to the destination directory.
func Run(opts Options) error {
	// Validate script exists and is executable
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

	// Execute the script
	cmd := exec.Command(opts.Script)
	cmd.Dir = opts.Workdir
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr

	if err := cmd.Run(); err != nil {
		return fmt.Errorf("script execution failed: %w", err)
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

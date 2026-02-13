package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/gofixpoint/clawbox/internal/sandbox"
	"github.com/spf13/cobra"
)

var topMaterializeCmd = &cobra.Command{
	Use:   "materialize [-- script-args...]",
	Short: "Run a script or command in an ephemeral Docker container and copy outputs to a destination",
	Long: `Run a script or command in an ephemeral Docker container and copy output
files to a destination directory.

The container runs with a working directory at /home/clawbox/workspace.
The script/command runs with CWD set to this workdir.

Exactly one of --script or --cmd must be specified.

The --outdir flag controls which container directory gets copied to --destdir:
  (default)    The workdir itself (script CWD)
  Absolute     The given absolute path inside the container
  Relative     Resolved relative to workdir

Host directories can be mounted into the container using --mount:
  --mount /host/path:/container/path:ro

Examples:
  clawbox materialize --cmd "echo hi > result.txt" --destdir /tmp/dest
  clawbox materialize --script ./hello.sh --destdir /tmp/dest
  clawbox materialize --mount /Users/me/data:/data:ro --cmd "cp /data/file.txt ." --destdir /tmp/dest`,
	Args: cobra.ArbitraryArgs,
	RunE: func(cmd *cobra.Command, args []string) error {
		cmd.SilenceUsage = true
		cmd.SilenceErrors = true

		script, _ := cmd.Flags().GetString("script")
		cmdStr, _ := cmd.Flags().GetString("cmd")
		outdir, _ := cmd.Flags().GetString("outdir")
		destdir, _ := cmd.Flags().GetString("destdir")
		image, _ := cmd.Flags().GetString("image")
		mountStrs, _ := cmd.Flags().GetStringArray("mount")

		if err := validateScriptCmdFlags(script, cmdStr, args); err != nil {
			return err
		}

		mounts, err := parseMountFlags(mountStrs)
		if err != nil {
			return err
		}

		absDestdir, err := filepath.Abs(destdir)
		if err != nil {
			return fmt.Errorf("failed to resolve destdir path: %w", err)
		}

		// Resolve outdir inside the container
		workdir := sandbox.SandboxWorkdir
		containerOutdir := workdir
		if outdir != "" {
			if filepath.IsAbs(outdir) {
				containerOutdir = outdir
			} else {
				containerOutdir = filepath.Join(workdir, outdir)
			}
		}

		// Create host temp dir to capture outputs
		tmpDir, err := os.MkdirTemp("", "clawbox-materialize-*")
		if err != nil {
			return fmt.Errorf("failed to create temp dir: %w", err)
		}
		defer os.RemoveAll(tmpDir)

		// Build docker run args
		dockerArgs := []string{"run", "--rm", "-w", workdir}

		// Mount temp dir as the outdir inside the container
		dockerArgs = append(dockerArgs, "-v", tmpDir+":"+containerOutdir)

		// User mounts
		for _, m := range mounts {
			vol := m.Source + ":" + m.Target
			if m.Mode == "ro" {
				vol += ":ro"
			}
			dockerArgs = append(dockerArgs, "-v", vol)
		}

		// Script auto-mount and command
		if script != "" {
			absScript, err := filepath.Abs(script)
			if err != nil {
				return fmt.Errorf("failed to resolve script path: %w", err)
			}
			dockerArgs = append(dockerArgs, "-v", absScript+":/.clawbox/script:ro")
			dockerArgs = append(dockerArgs, image, "/.clawbox/script")
			dockerArgs = append(dockerArgs, args...)
		} else {
			dockerArgs = append(dockerArgs, image, "bash", "-c", cmdStr)
		}

		// Run the container
		dockerCmd := exec.Command("docker", dockerArgs...)
		dockerCmd.Stdout = os.Stdout
		dockerCmd.Stderr = os.Stderr

		if script != "" {
			cmdLine := strings.Join(append([]string{script}, args...), " ")
			fmt.Fprintf(os.Stderr, "Running script in container:\n\n> %s\n\n", cmdLine)
		} else {
			fmt.Fprintf(os.Stderr, "Running command in container:\n\n> %s\n\n", cmdStr)
		}

		if err := dockerCmd.Run(); err != nil {
			return fmt.Errorf("container execution failed: %w", err)
		}

		// Create destdir if needed
		if err := os.MkdirAll(absDestdir, 0755); err != nil {
			return fmt.Errorf("failed to create destdir: %w", err)
		}

		// Rsync outputs to destdir
		rsyncCmd := exec.Command("rsync", "-a", tmpDir+"/", absDestdir+"/")
		rsyncCmd.Stdout = os.Stdout
		rsyncCmd.Stderr = os.Stderr
		if err := rsyncCmd.Run(); err != nil {
			return fmt.Errorf("failed to copy output files: %w", err)
		}

		fmt.Printf("Materialized output to %s\n", absDestdir)
		return nil
	},
}

func init() {
	rootCmd.AddCommand(topMaterializeCmd)

	topMaterializeCmd.Flags().String("script", "", "Path to the script to execute (mutually exclusive with --cmd)")
	topMaterializeCmd.Flags().String("cmd", "", "Bash command string to execute (mutually exclusive with --script)")
	topMaterializeCmd.Flags().String("outdir", "", "Container directory to copy from (default: workdir)")
	topMaterializeCmd.Flags().String("destdir", "", "Host directory where output files are copied (required)")
	topMaterializeCmd.Flags().String("image", "ubuntu:latest", "Docker image to use")
	topMaterializeCmd.Flags().StringArray("mount", nil, "Mount a host directory (source:target[:mode], mode defaults to rw)")
	topMaterializeCmd.MarkFlagRequired("destdir")
}

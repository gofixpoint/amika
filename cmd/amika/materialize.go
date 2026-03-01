package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/gofixpoint/amika/internal/sandbox"
	"github.com/spf13/cobra"
)

var topMaterializeCmd = &cobra.Command{
	Use:   "materialize [-- script-args...]",
	Short: "Run a script or command in an ephemeral Docker container and copy outputs to a destination",
	Long: `Run a script or command in an ephemeral Docker container and copy output
files to a destination directory.

The container runs with a working directory at /home/amika/workspace.
The script/command runs with CWD set to this workdir.

Exactly one of --script or --cmd must be specified.

The --outdir flag controls which container directory gets copied to --destdir:
  (default)    The workdir itself (script CWD)
  Absolute     The given absolute path inside the container
  Relative     Resolved relative to workdir

Host directories can be mounted into the container using --mount:
  --mount /host/path:/container/path:ro

Use --interactive (-i) to connect stdin/stdout for interactive programs like Claude:
  amika materialize -i --cmd claude --mount $(pwd):/workspace

Examples:
  amika materialize --cmd "echo hi > result.txt" --destdir /tmp/dest
  amika materialize --script ./hello.sh --destdir /tmp/dest
  amika materialize -i --cmd claude --mount $(pwd):/workspace --env ANTHROPIC_API_KEY=...`,
	Args: cobra.ArbitraryArgs,
	RunE: func(cmd *cobra.Command, args []string) error {
		cmd.SilenceUsage = true
		cmd.SilenceErrors = true

		script, _ := cmd.Flags().GetString("script")
		cmdStr, _ := cmd.Flags().GetString("cmd")
		outdir, _ := cmd.Flags().GetString("outdir")
		destdir, _ := cmd.Flags().GetString("destdir")
		image, _ := cmd.Flags().GetString("image")
		preset, _ := cmd.Flags().GetString("preset")
		mountStrs, _ := cmd.Flags().GetStringArray("mount")
		envStrs, _ := cmd.Flags().GetStringArray("env")
		interactive, _ := cmd.Flags().GetBool("interactive")

		if err := validateScriptCmdFlags(script, cmdStr, args); err != nil {
			return err
		}

		resolvedImage, err := sandbox.ResolveAndEnsureImage(sandbox.PresetImageOptions{
			Image:              image,
			Preset:             preset,
			ImageFlagChanged:   cmd.Flags().Changed("image"),
			DefaultBuildPreset: "coder",
		})
		if err != nil {
			return err
		}
		image = resolvedImage.Image

		if destdir == "" {
			return fmt.Errorf("--destdir is required")
		}

		mounts, err := parseMountFlags(mountStrs)
		if err != nil {
			return err
		}

		// Auto-mount host Claude config for the claude preset
		if preset == "claude" || preset == "coder" {
			homeDir, err := os.UserHomeDir()
			if err == nil {
				claudeDir := filepath.Join(homeDir, ".claude")
				if _, err := os.Stat(claudeDir); err == nil {
					mounts = append(mounts, sandbox.MountBinding{
						Source: claudeDir,
						Target: "/root/.claude",
						Mode:   "rw",
					})
					claudeJSON := filepath.Join(homeDir, ".claude.json")
					if _, err := os.Stat(claudeJSON); err == nil {
						mounts = append(mounts, sandbox.MountBinding{
							Source: claudeJSON,
							Target: "/root/.claude.json",
							Mode:   "rw",
						})
					}
				}
			}
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

		// If destdir is set, create temp dir for output capture
		var tmpDir string
		if destdir != "" {
			tmpDir, err = os.MkdirTemp("", "amika-materialize-*")
			if err != nil {
				return fmt.Errorf("failed to create temp dir: %w", err)
			}
			defer os.RemoveAll(tmpDir)
		}

		// Build docker run args
		dockerArgs := []string{"run", "--rm"}
		if interactive {
			dockerArgs = append(dockerArgs, "-it")
		}
		dockerArgs = append(dockerArgs, "-w", workdir)

		// Mount temp dir as the outdir inside the container (only if capturing output)
		if tmpDir != "" {
			dockerArgs = append(dockerArgs, "-v", tmpDir+":"+containerOutdir)
		}

		// User mounts
		for _, m := range mounts {
			vol := m.Source + ":" + m.Target
			if m.Mode == "ro" {
				vol += ":ro"
			}
			dockerArgs = append(dockerArgs, "-v", vol)
		}

		// Environment variables
		for _, e := range envStrs {
			dockerArgs = append(dockerArgs, "-e", e)
		}

		// Script auto-mount and command
		if script != "" {
			absScript, err := filepath.Abs(script)
			if err != nil {
				return fmt.Errorf("failed to resolve script path: %w", err)
			}
			dockerArgs = append(dockerArgs, "-v", absScript+":/.amika/script:ro")
			dockerArgs = append(dockerArgs, image, "/.amika/script")
			dockerArgs = append(dockerArgs, args...)
		} else {
			if interactive {
				// In interactive mode, run the command directly (not via bash -c)
				// so the TTY works properly with programs like claude
				dockerArgs = append(dockerArgs, image)
				dockerArgs = append(dockerArgs, strings.Fields(cmdStr)...)
			} else {
				dockerArgs = append(dockerArgs, image, "bash", "-c", cmdStr)
			}
		}

		// Run the container
		dockerCmd := exec.Command("docker", dockerArgs...)
		dockerCmd.Stdout = os.Stdout
		dockerCmd.Stderr = os.Stderr
		if interactive {
			dockerCmd.Stdin = os.Stdin
		}

		if !interactive {
			if script != "" {
				cmdLine := strings.Join(append([]string{script}, args...), " ")
				fmt.Fprintf(os.Stderr, "Running script in container:\n\n> %s\n\n", cmdLine)
			} else {
				fmt.Fprintf(os.Stderr, "Running command in container:\n\n> %s\n\n", cmdStr)
			}
		}

		if err := dockerCmd.Run(); err != nil {
			return fmt.Errorf("container execution failed: %w", err)
		}

		// Rsync outputs to destdir if requested
		if destdir != "" {
			absDestdir, err := filepath.Abs(destdir)
			if err != nil {
				return fmt.Errorf("failed to resolve destdir path: %w", err)
			}
			if err := os.MkdirAll(absDestdir, 0755); err != nil {
				return fmt.Errorf("failed to create destdir: %w", err)
			}
			rsyncCmd := exec.Command("rsync", "-a", tmpDir+"/", absDestdir+"/")
			rsyncCmd.Stdout = os.Stdout
			rsyncCmd.Stderr = os.Stderr
			if err := rsyncCmd.Run(); err != nil {
				return fmt.Errorf("failed to copy output files: %w", err)
			}
			fmt.Printf("Materialized output to %s\n", absDestdir)
		}

		return nil
	},
}

func init() {
	rootCmd.AddCommand(topMaterializeCmd)

	topMaterializeCmd.Flags().String("script", "", "Path to the script to execute (mutually exclusive with --cmd)")
	topMaterializeCmd.Flags().String("cmd", "", "Bash command string to execute (mutually exclusive with --script)")
	topMaterializeCmd.Flags().String("outdir", "", "Container directory to copy from (default: workdir)")
	topMaterializeCmd.Flags().String("destdir", "", "Host directory where output files are copied")
	topMaterializeCmd.Flags().String("image", sandbox.DefaultCoderImage, "Docker image to use")
	topMaterializeCmd.Flags().String("preset", "", "Use a preset environment (e.g. \"coder\" or \"claude\")")
	topMaterializeCmd.Flags().StringArray("mount", nil, "Mount a host directory (source:target[:mode], mode defaults to rw)")
	topMaterializeCmd.Flags().StringArray("env", nil, "Set environment variable (KEY=VALUE)")
	topMaterializeCmd.Flags().BoolP("interactive", "i", false, "Run interactively with TTY (for programs like claude)")
}

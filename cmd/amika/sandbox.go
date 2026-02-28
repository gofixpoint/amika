package main

import (
	"bufio"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"text/tabwriter"
	"time"

	"github.com/gofixpoint/amika/internal/config"
	"github.com/gofixpoint/amika/internal/sandbox"
	"github.com/spf13/cobra"
)

var sandboxCmd = &cobra.Command{
	Use:   "sandbox",
	Short: "Manage sandboxes",
	Long:  `Create and delete sandboxed environments backed by container providers.`,
}

var sandboxCreateCmd = &cobra.Command{
	Use:   "create",
	Short: "Create a new sandbox",
	Long:  `Create a new sandbox using the specified provider. Currently only "docker" is supported.`,
	Args:  cobra.NoArgs,
	RunE: func(cmd *cobra.Command, _ []string) error {
		cmd.SilenceUsage = true

		provider, _ := cmd.Flags().GetString("provider")
		name, _ := cmd.Flags().GetString("name")
		image, _ := cmd.Flags().GetString("image")
		preset, _ := cmd.Flags().GetString("preset")
		mountStrs, _ := cmd.Flags().GetStringArray("mount")
		envStrs, _ := cmd.Flags().GetStringArray("env")
		yes, _ := cmd.Flags().GetBool("yes")

		if provider != "docker" {
			return fmt.Errorf("unsupported provider %q: only \"docker\" is supported", provider)
		}

		resolvedImage, err := sandbox.ResolveAndEnsureImage(sandbox.PresetImageOptions{
			Image:              image,
			Preset:             preset,
			ImageFlagChanged:   cmd.Flags().Changed("image"),
			DefaultBuildPreset: "claude",
		})
		if err != nil {
			return err
		}
		image = resolvedImage.Image

		mounts, err := parseMountFlags(mountStrs)
		if err != nil {
			return err
		}

		sandboxesFile, err := config.SandboxesStateFile()
		if err != nil {
			return err
		}
		store := sandbox.NewStore(sandboxesFile)

		// Generate a name if not provided
		if name == "" {
			for {
				name = sandbox.GenerateName()
				if _, err := store.Get(name); err != nil {
					break // name is available
				}
			}
		} else if _, err := store.Get(name); err == nil {
			return fmt.Errorf("sandbox %q already exists", name)
		}

		if len(mounts) > 0 && !yes {
			fmt.Println("You are about to mount:")
			for _, m := range mounts {
				fmt.Printf("  %s -> %s:%s (%s)\n", m.Source, name, m.Target, m.Mode)
			}
			fmt.Print("Continue? [y/N] ")
			reader := bufio.NewReader(os.Stdin)
			answer, _ := reader.ReadString('\n')
			answer = strings.TrimSpace(strings.ToLower(answer))
			if answer != "y" && answer != "yes" {
				fmt.Println("Aborted.")
				return nil
			}
		}

		containerID, err := sandbox.CreateDockerSandbox(name, image, mounts, envStrs)
		if err != nil {
			return err
		}

		info := sandbox.Info{
			Name:        name,
			Provider:    provider,
			ContainerID: containerID,
			Image:       image,
			CreatedAt:   time.Now().UTC().Format(time.RFC3339),
			Preset:      preset,
			Mounts:      mounts,
			Env:         envStrs,
		}
		if err := store.Save(info); err != nil {
			return fmt.Errorf("sandbox created but failed to save state: %w", err)
		}

		fmt.Printf("Sandbox %q created (container %s)\n", name, containerID[:12])
		return nil
	},
}

var sandboxDeleteCmd = &cobra.Command{
	Use:   "delete <name>",
	Short: "Delete a sandbox",
	Long:  `Delete a sandbox and remove its backing container.`,
	Args:  cobra.ExactArgs(1),
	RunE: func(_ *cobra.Command, args []string) error {
		name := args[0]

		sandboxesFile, err := config.SandboxesStateFile()
		if err != nil {
			return err
		}
		store := sandbox.NewStore(sandboxesFile)

		info, err := store.Get(name)
		if err != nil {
			return fmt.Errorf("sandbox %q not found", name)
		}

		if info.Provider == "docker" {
			if err := sandbox.RemoveDockerSandbox(name); err != nil {
				return err
			}
		}

		if err := store.Remove(name); err != nil {
			return fmt.Errorf("container removed but failed to update state: %w", err)
		}

		fmt.Printf("Sandbox %q deleted\n", name)
		return nil
	},
}

var sandboxListCmd = &cobra.Command{
	Use:   "list",
	Short: "List all sandboxes",
	Args:  cobra.NoArgs,
	RunE: func(cmd *cobra.Command, _ []string) error {
		sandboxesFile, err := config.SandboxesStateFile()
		if err != nil {
			return err
		}
		store := sandbox.NewStore(sandboxesFile)

		sandboxes, err := store.List()
		if err != nil {
			return err
		}

		if len(sandboxes) == 0 {
			fmt.Println("No sandboxes found.")
			return nil
		}

		w := tabwriter.NewWriter(cmd.OutOrStdout(), 0, 4, 2, ' ', 0)
		fmt.Fprintln(w, "NAME\tPROVIDER\tIMAGE\tCREATED")
		for _, sb := range sandboxes {
			fmt.Fprintf(w, "%s\t%s\t%s\t%s\n", sb.Name, sb.Provider, sb.Image, sb.CreatedAt)
		}
		w.Flush()
		return nil
	},
}

// parseMountFlags parses --mount flag values in the format source:target[:mode].
// Mode defaults to "rw" if omitted.
func parseMountFlags(flags []string) ([]sandbox.MountBinding, error) {
	var mounts []sandbox.MountBinding
	seen := make(map[string]bool)

	for _, raw := range flags {
		parts := strings.SplitN(raw, ":", 3)
		if len(parts) < 2 {
			return nil, fmt.Errorf("invalid mount format %q: expected source:target[:mode]", raw)
		}

		source := parts[0]
		target := parts[1]
		mode := "rw"
		if len(parts) == 3 {
			mode = parts[2]
		}

		absSource, err := filepath.Abs(source)
		if err != nil {
			return nil, fmt.Errorf("failed to resolve source path %q: %w", source, err)
		}

		if !strings.HasPrefix(target, "/") {
			return nil, fmt.Errorf("mount target %q must be an absolute path", target)
		}

		if mode != "ro" && mode != "rw" {
			return nil, fmt.Errorf("invalid mount mode %q: must be \"ro\" or \"rw\"", mode)
		}

		if seen[target] {
			return nil, fmt.Errorf("duplicate mount target %q", target)
		}
		seen[target] = true

		mounts = append(mounts, sandbox.MountBinding{
			Source: absSource,
			Target: target,
			Mode:   mode,
		})
	}
	return mounts, nil
}

func init() {
	rootCmd.AddCommand(sandboxCmd)
	sandboxCmd.AddCommand(sandboxCreateCmd)
	sandboxCmd.AddCommand(sandboxDeleteCmd)
	sandboxCmd.AddCommand(sandboxListCmd)

	// Create flags
	sandboxCreateCmd.Flags().String("provider", "docker", "Sandbox provider")
	sandboxCreateCmd.Flags().String("name", "", "Name for the sandbox (auto-generated if not set)")
	sandboxCreateCmd.Flags().String("image", "amika-claude:latest", "Docker image to use")
	sandboxCreateCmd.Flags().String("preset", "", "Use a preset environment (e.g. \"claude\")")
	sandboxCreateCmd.Flags().StringArray("mount", nil, "Mount a host directory (source:target[:mode], mode defaults to rw)")
	sandboxCreateCmd.Flags().StringArray("env", nil, "Set environment variable (KEY=VALUE)")
	sandboxCreateCmd.Flags().Bool("yes", false, "Skip mount confirmation prompt")

}

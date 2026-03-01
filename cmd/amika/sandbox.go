package main

import (
	"bufio"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
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
		volumeStrs, _ := cmd.Flags().GetStringArray("volume")
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
		volumeMounts, err := parseVolumeFlags(volumeStrs)
		if err != nil {
			return err
		}
		if err := validateMountTargets(mounts, volumeMounts); err != nil {
			return err
		}

		sandboxesFile, err := config.SandboxesStateFile()
		if err != nil {
			return err
		}
		store := sandbox.NewStore(sandboxesFile)
		volumesFile, err := config.VolumesStateFile()
		if err != nil {
			return err
		}
		volumeStore := sandbox.NewVolumeStore(volumesFile)

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

		if (len(mounts) > 0 || len(volumeMounts) > 0) && !yes {
			fmt.Println("You are about to mount:")
			for _, m := range mounts {
				fmt.Printf("  %s -> %s:%s (%s)\n", m.Source, name, m.Target, m.Mode)
			}
			for _, v := range volumeMounts {
				fmt.Printf("  volume %s -> %s:%s (%s)\n", v.Volume, name, v.Target, v.Mode)
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

		var runtimeMounts []sandbox.MountBinding
		createdVolumes := make([]string, 0)
		addedRefs := make(map[string]bool)
		rollbackVolumeState := func() {
			for volumeName := range addedRefs {
				_ = volumeStore.RemoveSandboxRef(volumeName, name)
			}
			for _, volumeName := range createdVolumes {
				_ = volumeStore.Remove(volumeName)
				_ = sandbox.RemoveDockerVolume(volumeName)
			}
		}

		for _, m := range mounts {
			if m.Mode != "rwcopy" {
				runtimeMounts = append(runtimeMounts, m)
				continue
			}

			stat, err := os.Stat(m.Source)
			if err != nil {
				rollbackVolumeState()
				return fmt.Errorf("rwcopy source %q is not accessible: %w", m.Source, err)
			}
			if !stat.IsDir() {
				rollbackVolumeState()
				return fmt.Errorf("rwcopy source %q must be a directory", m.Source)
			}

			volumeName := generateRWCopyVolumeName(name, m.Target)
			if err := sandbox.CreateDockerVolume(volumeName); err != nil {
				rollbackVolumeState()
				return err
			}
			createdVolumes = append(createdVolumes, volumeName)

			if err := sandbox.CopyHostDirToVolume(volumeName, m.Source); err != nil {
				rollbackVolumeState()
				return err
			}

			info := sandbox.VolumeInfo{
				Name:        volumeName,
				CreatedAt:   time.Now().UTC().Format(time.RFC3339),
				CreatedBy:   "rwcopy",
				SourcePath:  m.Source,
				SandboxRefs: []string{name},
			}
			if err := volumeStore.Save(info); err != nil {
				rollbackVolumeState()
				return fmt.Errorf("failed to save volume state for %q: %w", volumeName, err)
			}
			addedRefs[volumeName] = true

			runtimeMounts = append(runtimeMounts, sandbox.MountBinding{
				Type:         "volume",
				Volume:       volumeName,
				Target:       m.Target,
				Mode:         "rw",
				SnapshotFrom: m.Source,
			})
		}

		for _, v := range volumeMounts {
			if _, err := volumeStore.Get(v.Volume); err != nil {
				rollbackVolumeState()
				return fmt.Errorf("volume %q is not tracked; create via rwcopy first", v.Volume)
			}
			if err := volumeStore.AddSandboxRef(v.Volume, name); err != nil {
				rollbackVolumeState()
				return fmt.Errorf("failed to attach volume %q: %w", v.Volume, err)
			}
			addedRefs[v.Volume] = true
			runtimeMounts = append(runtimeMounts, v)
		}

		containerID, err := sandbox.CreateDockerSandbox(name, image, runtimeMounts, envStrs)
		if err != nil {
			rollbackVolumeState()
			return err
		}

		info := sandbox.Info{
			Name:        name,
			Provider:    provider,
			ContainerID: containerID,
			Image:       image,
			CreatedAt:   time.Now().UTC().Format(time.RFC3339),
			Preset:      preset,
			Mounts:      runtimeMounts,
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
	RunE: func(cmd *cobra.Command, args []string) error {
		name := args[0]
		deleteVolumes, _ := cmd.Flags().GetBool("delete-volumes")

		sandboxesFile, err := config.SandboxesStateFile()
		if err != nil {
			return err
		}
		store := sandbox.NewStore(sandboxesFile)
		volumesFile, err := config.VolumesStateFile()
		if err != nil {
			return err
		}
		volumeStore := sandbox.NewVolumeStore(volumesFile)

		info, err := store.Get(name)
		if err != nil {
			return fmt.Errorf("sandbox %q not found", name)
		}

		if info.Provider == "docker" {
			if err := sandbox.RemoveDockerSandbox(name); err != nil {
				return err
			}
		}

		volumeStatuses, volumeErr := cleanupSandboxVolumes(volumeStore, name, deleteVolumes, sandbox.RemoveDockerVolume)

		if err := store.Remove(name); err != nil {
			return fmt.Errorf("container removed but failed to update state: %w", err)
		}

		fmt.Printf("Sandbox %q deleted\n", name)
		for _, line := range volumeStatuses {
			fmt.Println(line)
		}
		if volumeErr != nil {
			return volumeErr
		}
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
// Mode defaults to "rwcopy" if omitted.
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
		mode := "rwcopy"
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

		if mode != "ro" && mode != "rw" && mode != "rwcopy" {
			return nil, fmt.Errorf("invalid mount mode %q: must be \"ro\", \"rw\", or \"rwcopy\"", mode)
		}

		if seen[target] {
			return nil, fmt.Errorf("duplicate mount target %q", target)
		}
		seen[target] = true

		mounts = append(mounts, sandbox.MountBinding{
			Type:   "bind",
			Source: absSource,
			Target: target,
			Mode:   mode,
		})
	}
	return mounts, nil
}

// parseVolumeFlags parses --volume flag values in the format name:target[:mode].
// Mode defaults to "rw" if omitted.
func parseVolumeFlags(flags []string) ([]sandbox.MountBinding, error) {
	var mounts []sandbox.MountBinding
	seen := make(map[string]bool)

	for _, raw := range flags {
		parts := strings.SplitN(raw, ":", 3)
		if len(parts) < 2 {
			return nil, fmt.Errorf("invalid volume format %q: expected name:target[:mode]", raw)
		}

		name := strings.TrimSpace(parts[0])
		target := parts[1]
		mode := "rw"
		if len(parts) == 3 {
			mode = parts[2]
		}

		if name == "" {
			return nil, fmt.Errorf("volume name must not be empty in %q", raw)
		}
		if !strings.HasPrefix(target, "/") {
			return nil, fmt.Errorf("mount target %q must be an absolute path", target)
		}
		if mode != "ro" && mode != "rw" {
			return nil, fmt.Errorf("invalid volume mount mode %q: must be \"ro\" or \"rw\"", mode)
		}
		if seen[target] {
			return nil, fmt.Errorf("duplicate mount target %q", target)
		}
		seen[target] = true

		mounts = append(mounts, sandbox.MountBinding{
			Type:   "volume",
			Volume: name,
			Target: target,
			Mode:   mode,
		})
	}
	return mounts, nil
}

func validateMountTargets(bindMounts, volumeMounts []sandbox.MountBinding) error {
	seen := make(map[string]bool, len(bindMounts)+len(volumeMounts))
	for _, m := range bindMounts {
		seen[m.Target] = true
	}
	for _, m := range volumeMounts {
		if seen[m.Target] {
			return fmt.Errorf("duplicate mount target %q", m.Target)
		}
		seen[m.Target] = true
	}
	return nil
}

func generateRWCopyVolumeName(sandboxName, target string) string {
	sanitizedTarget := strings.NewReplacer("/", "-", "_", "-", ".", "-").Replace(strings.TrimPrefix(target, "/"))
	if sanitizedTarget == "" {
		sanitizedTarget = "root"
	}
	return "amika-rwcopy-" + sandboxName + "-" + sanitizedTarget + "-" + strconv.FormatInt(time.Now().UnixNano(), 10)
}

func cleanupSandboxVolumes(
	volumeStore sandbox.VolumeStore,
	sandboxName string,
	deleteVolumes bool,
	removeVolumeFn func(string) error,
) ([]string, error) {
	volumes, err := volumeStore.VolumesForSandbox(sandboxName)
	if err != nil {
		return nil, fmt.Errorf("failed to load associated volumes: %w", err)
	}
	if len(volumes) == 0 {
		return nil, nil
	}

	statuses := make([]string, 0, len(volumes))
	var errs []string

	for _, volume := range volumes {
		if err := volumeStore.RemoveSandboxRef(volume.Name, sandboxName); err != nil {
			statuses = append(statuses, fmt.Sprintf("volume %s: delete-failed: failed to update refs", volume.Name))
			errs = append(errs, fmt.Sprintf("failed to remove sandbox ref for volume %q: %v", volume.Name, err))
			continue
		}

		if !deleteVolumes {
			statuses = append(statuses, fmt.Sprintf("volume %s: preserved", volume.Name))
			continue
		}

		inUse, err := volumeStore.IsInUse(volume.Name)
		if err != nil {
			statuses = append(statuses, fmt.Sprintf("volume %s: delete-failed: failed to check usage", volume.Name))
			errs = append(errs, fmt.Sprintf("failed to check usage for volume %q: %v", volume.Name, err))
			continue
		}
		if inUse {
			statuses = append(statuses, fmt.Sprintf("volume %s: preserved (still referenced)", volume.Name))
			continue
		}

		if err := removeVolumeFn(volume.Name); err != nil {
			statuses = append(statuses, fmt.Sprintf("volume %s: delete-failed: %v", volume.Name, err))
			errs = append(errs, fmt.Sprintf("failed to delete volume %q: %v", volume.Name, err))
			continue
		}
		if err := volumeStore.Remove(volume.Name); err != nil {
			statuses = append(statuses, fmt.Sprintf("volume %s: delete-failed: failed to remove state entry", volume.Name))
			errs = append(errs, fmt.Sprintf("failed to remove volume state for %q: %v", volume.Name, err))
			continue
		}
		statuses = append(statuses, fmt.Sprintf("volume %s: deleted", volume.Name))
	}

	if len(errs) > 0 {
		return statuses, fmt.Errorf("%s", strings.Join(errs, "; "))
	}
	return statuses, nil
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
	sandboxCreateCmd.Flags().StringArray("mount", nil, "Mount a host directory (source:target[:mode], mode defaults to rwcopy)")
	sandboxCreateCmd.Flags().StringArray("volume", nil, "Mount an existing named volume (name:target[:mode], mode defaults to rw)")
	sandboxCreateCmd.Flags().StringArray("env", nil, "Set environment variable (KEY=VALUE)")
	sandboxCreateCmd.Flags().Bool("yes", false, "Skip mount confirmation prompt")
	sandboxDeleteCmd.Flags().Bool("delete-volumes", false, "Also delete associated volumes that are no longer referenced")

}

package main

import (
	"bufio"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"text/tabwriter"
	"time"

	"github.com/gofixpoint/amika/internal/agentconfig"
	"github.com/gofixpoint/amika/internal/config"
	"github.com/gofixpoint/amika/internal/sandbox"
	"github.com/spf13/cobra"
)

var sandboxCmd = &cobra.Command{
	Use:   "sandbox",
	Short: "Manage sandboxes",
	Long:  `Create and delete sandboxed environments backed by container providers.`,
}

const sandboxConnectWorkdir = "/home/amika"

var runSandboxConnect = func(name, shell string, stdin io.Reader, stdout, stderr io.Writer) error {
	dockerArgs := buildSandboxConnectArgs(name, shell)
	dockerCmd := exec.Command("docker", dockerArgs...)
	dockerCmd.Stdin = stdin
	dockerCmd.Stdout = stdout
	dockerCmd.Stderr = stderr
	return dockerCmd.Run()
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
		gitPath, _ := cmd.Flags().GetString("git")
		noClean, _ := cmd.Flags().GetBool("no-clean")
		envStrs, _ := cmd.Flags().GetStringArray("env")
		yes, _ := cmd.Flags().GetBool("yes")
		connect, _ := cmd.Flags().GetBool("connect")
		gitFlagChanged := cmd.Flags().Changed("git")

		if provider != "docker" {
			return fmt.Errorf("unsupported provider %q: only \"docker\" is supported", provider)
		}
		if err := validateGitFlags(gitFlagChanged, noClean); err != nil {
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

		mounts, err := parseMountFlags(mountStrs)
		if err != nil {
			return err
		}
		volumeMounts, err := parseVolumeFlags(volumeStrs)
		if err != nil {
			return err
		}
		var gitMountInfo *gitMountInfo
		if gitFlagChanged {
			info, cleanupGitMount, err := prepareGitMount(gitPath, noClean, cloneGitRepo)
			if err != nil {
				return err
			}
			defer cleanupGitMount()
			gitMountInfo = &info
			mounts = append(mounts, info.Mount)
		}
		if agentconfig.IsAgentPreset(preset) {
			homeDir, err := os.UserHomeDir()
			if err == nil {
				agentMounts := agentconfig.RWCopyMounts(agentconfig.AllMounts(homeDir))
				mounts = append(mounts, agentMounts...)
			}
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
		fileMountsFile, err := config.FileMountsStateFile()
		if err != nil {
			return err
		}
		fileMountStore := sandbox.NewFileMountStore(fileMountsFile)
		fileMountsBaseDir, err := config.FileMountsDir()
		if err != nil {
			return err
		}

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
			if gitMountInfo != nil {
				mode := "clean"
				if gitMountInfo.NoClean {
					mode = "no-clean"
				}
				fmt.Println("Git repo to mount:")
				fmt.Printf("  repo: %s\n", gitMountInfo.RepoName)
				fmt.Printf("  root: %s\n", gitMountInfo.RepoRoot)
				fmt.Printf("  mode: %s\n", mode)
				fmt.Printf("  target: %s\n", gitMountInfo.Mount.Target)
			}
			fmt.Println("You are about to mount:")
			for _, m := range mounts {
				source := m.Source
				if m.Mode == "rwcopy" && m.SnapshotFrom != "" {
					source = m.SnapshotFrom
				}
				fmt.Printf("  %s -> %s:%s (%s)\n", source, name, m.Target, m.Mode)
			}
			for _, v := range volumeMounts {
				fmt.Printf("  volume %s -> %s:%s (%s)\n", v.Volume, name, v.Target, v.Mode)
			}
			reader := bufio.NewReader(os.Stdin)
			confirmed, err := promptForConfirmation(reader)
			if err != nil {
				return err
			}
			if !confirmed {
				fmt.Println("Aborted.")
				return nil
			}
		}

		var runtimeMounts []sandbox.MountBinding
		createdVolumes := make([]string, 0)
		addedRefs := make(map[string]bool)
		createdFileMountDirs := make([]string, 0)
		addedFileRefs := make(map[string]bool)
		rollbackAll := func() {
			for volumeName := range addedRefs {
				_ = volumeStore.RemoveSandboxRef(volumeName, name)
			}
			for _, volumeName := range createdVolumes {
				_ = volumeStore.Remove(volumeName)
				_ = sandbox.RemoveDockerVolume(volumeName)
			}
			for mountName := range addedFileRefs {
				_ = fileMountStore.Remove(mountName)
			}
			for _, dir := range createdFileMountDirs {
				_ = os.RemoveAll(dir)
			}
		}

		for _, m := range mounts {
			if m.Mode != "rwcopy" {
				runtimeMounts = append(runtimeMounts, m)
				continue
			}

			stat, err := os.Stat(m.Source)
			if err != nil {
				rollbackAll()
				return fmt.Errorf("rwcopy source %q is not accessible: %w", m.Source, err)
			}

			if stat.IsDir() {
				volumeName := generateRWCopyVolumeName(name, m.Target)
				if err := sandbox.CreateDockerVolume(volumeName); err != nil {
					rollbackAll()
					return err
				}
				createdVolumes = append(createdVolumes, volumeName)

				if err := sandbox.CopyHostDirToVolume(volumeName, m.Source); err != nil {
					rollbackAll()
					return err
				}

				volInfo := sandbox.VolumeInfo{
					Name:        volumeName,
					CreatedAt:   time.Now().UTC().Format(time.RFC3339),
					CreatedBy:   "rwcopy",
					SourcePath:  m.Source,
					SandboxRefs: []string{name},
				}
				if err := volumeStore.Save(volInfo); err != nil {
					rollbackAll()
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
			} else {
				mountName := generateRWCopyFileMountName(name, m.Target)
				copyDir := filepath.Join(fileMountsBaseDir, mountName)
				if err := os.MkdirAll(copyDir, 0755); err != nil {
					rollbackAll()
					return fmt.Errorf("failed to create file mount directory for %q: %w", mountName, err)
				}
				createdFileMountDirs = append(createdFileMountDirs, copyDir)

				copyPath := filepath.Join(copyDir, filepath.Base(m.Source))
				if err := copyFile(m.Source, copyPath); err != nil {
					rollbackAll()
					return fmt.Errorf("failed to copy file for rwcopy mount %q: %w", m.Source, err)
				}

				fmInfo := sandbox.FileMountInfo{
					Name:        mountName,
					Type:        "file",
					CreatedAt:   time.Now().UTC().Format(time.RFC3339),
					CreatedBy:   "rwcopy",
					SourcePath:  m.Source,
					CopyPath:    copyPath,
					SandboxRefs: []string{name},
				}
				if err := fileMountStore.Save(fmInfo); err != nil {
					rollbackAll()
					return fmt.Errorf("failed to save file mount state for %q: %w", mountName, err)
				}
				addedFileRefs[mountName] = true

				runtimeMounts = append(runtimeMounts, sandbox.MountBinding{
					Type:         "bind",
					Source:       copyPath,
					Target:       m.Target,
					Mode:         "rw",
					SnapshotFrom: m.Source,
				})
			}
		}

		for _, v := range volumeMounts {
			if _, err := volumeStore.Get(v.Volume); err != nil {
				rollbackAll()
				return fmt.Errorf("volume %q is not tracked; create via rwcopy first", v.Volume)
			}
			if err := volumeStore.AddSandboxRef(v.Volume, name); err != nil {
				rollbackAll()
				return fmt.Errorf("failed to attach volume %q: %w", v.Volume, err)
			}
			addedRefs[v.Volume] = true
			runtimeMounts = append(runtimeMounts, v)
		}

		containerID, err := sandbox.CreateDockerSandbox(name, image, runtimeMounts, envStrs)
		if err != nil {
			rollbackAll()
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
		if connect {
			if err := runSandboxConnect(name, "zsh", os.Stdin, os.Stdout, os.Stderr); err != nil {
				return fmt.Errorf("sandbox %q created but failed to connect with shell %q: %w", name, "zsh", err)
			}
		}
		return nil
	},
}

var sandboxDeleteCmd = &cobra.Command{
	Use:     "delete <name>",
	Aliases: []string{"rm", "remove"},
	Short:   "Delete a sandbox",
	Long:    `Delete a sandbox and remove its backing container.`,
	Args:    cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		name := args[0]
		deleteVolumes, _ := cmd.Flags().GetBool("delete-volumes")
		keepVolumes, _ := cmd.Flags().GetBool("keep-volumes")
		deleteVolumesSet := cmd.Flags().Changed("delete-volumes")
		keepVolumesSet := cmd.Flags().Changed("keep-volumes")
		if err := validateDeleteVolumeFlags(deleteVolumesSet, deleteVolumes, keepVolumesSet, keepVolumes); err != nil {
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
		fileMountsFile, err := config.FileMountsStateFile()
		if err != nil {
			return err
		}
		fileMountStore := sandbox.NewFileMountStore(fileMountsFile)

		info, err := store.Get(name)
		if err != nil {
			return fmt.Errorf("sandbox %q not found", name)
		}

		deleteVolumes, err = resolveDeleteVolumes(
			volumeStore,
			fileMountStore,
			name,
			deleteVolumesSet,
			keepVolumesSet,
			bufio.NewReader(cmd.InOrStdin()),
		)
		if err != nil {
			return err
		}

		if info.Provider == "docker" {
			if err := sandbox.RemoveDockerSandbox(name); err != nil {
				return err
			}
		}

		volumeStatuses, volumeErr := cleanupSandboxVolumes(volumeStore, name, deleteVolumes, sandbox.RemoveDockerVolume)
		fileMountStatuses, fileMountErr := cleanupSandboxFileMounts(fileMountStore, name, deleteVolumes)

		if err := store.Remove(name); err != nil {
			return fmt.Errorf("container removed but failed to update state: %w", err)
		}

		fmt.Printf("Sandbox %q deleted\n", name)
		for _, line := range volumeStatuses {
			fmt.Println(line)
		}
		for _, line := range fileMountStatuses {
			fmt.Println(line)
		}
		if volumeErr != nil {
			return volumeErr
		}
		if fileMountErr != nil {
			return fileMountErr
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

var sandboxConnectCmd = &cobra.Command{
	Use:   "connect <name>",
	Short: "Connect to a sandbox console",
	Long:  `Connect to a running sandbox container and open an interactive shell.`,
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		cmd.SilenceUsage = true

		name := args[0]
		shell, _ := cmd.Flags().GetString("shell")
		if err := validateShell(shell); err != nil {
			return err
		}

		sandboxesFile, err := config.SandboxesStateFile()
		if err != nil {
			return err
		}
		store := sandbox.NewStore(sandboxesFile)
		info, err := store.Get(name)
		if err != nil {
			return fmt.Errorf("sandbox %q not found", name)
		}
		if info.Provider != "docker" {
			return fmt.Errorf("unsupported provider %q: only \"docker\" is supported", info.Provider)
		}

		if err := runSandboxConnect(name, shell, os.Stdin, os.Stdout, os.Stderr); err != nil {
			return fmt.Errorf("failed to connect to sandbox %q with shell %q: %w", name, shell, err)
		}
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

func validateGitFlags(gitEnabled, noClean bool) error {
	if noClean && !gitEnabled {
		return fmt.Errorf("--no-clean requires --git")
	}
	return nil
}

func validateShell(shell string) error {
	if strings.TrimSpace(shell) == "" {
		return fmt.Errorf("--shell must not be empty")
	}
	return nil
}

func buildSandboxConnectArgs(name, shell string) []string {
	return []string{"exec", "-it", "-w", sandboxConnectWorkdir, name, shell}
}

type gitMountInfo struct {
	RepoName string
	RepoRoot string
	NoClean  bool
	Mount    sandbox.MountBinding
}

func prepareGitMount(startPath string, noClean bool, cloneFn func(src, dst string) error) (gitMountInfo, func(), error) {
	repoRoot, err := resolveGitRoot(startPath)
	if err != nil {
		return gitMountInfo{}, func() {}, err
	}

	repoName := filepath.Base(repoRoot)
	target := path.Join(sandbox.SandboxWorkdir, repoName)
	tmpDir, err := os.MkdirTemp("", "amika-git-mount-*")
	if err != nil {
		return gitMountInfo{}, func() {}, fmt.Errorf("failed to create temp directory for git mount: %w", err)
	}
	preparedRepo := filepath.Join(tmpDir, repoName)
	if noClean {
		if err := copyRepoWorkingTree(repoRoot, preparedRepo); err != nil {
			_ = os.RemoveAll(tmpDir)
			return gitMountInfo{}, func() {}, err
		}
	} else {
		if err := cloneFn(repoRoot, preparedRepo); err != nil {
			_ = os.RemoveAll(tmpDir)
			return gitMountInfo{}, func() {}, err
		}
	}
	if err := syncGitRemotes(repoRoot, preparedRepo); err != nil {
		_ = os.RemoveAll(tmpDir)
		return gitMountInfo{}, func() {}, err
	}
	cleanup := func() { _ = os.RemoveAll(tmpDir) }

	return gitMountInfo{
		RepoName: repoName,
		RepoRoot: repoRoot,
		NoClean:  noClean,
		Mount: sandbox.MountBinding{
			Type:         "bind",
			Source:       preparedRepo,
			Target:       target,
			Mode:         "rwcopy",
			SnapshotFrom: repoRoot,
		},
	}, cleanup, nil
}

func resolveGitRoot(startPath string) (string, error) {
	if startPath == "" {
		startPath = "."
	}
	absPath, err := filepath.Abs(startPath)
	if err != nil {
		return "", fmt.Errorf("failed to resolve git start path %q: %w", startPath, err)
	}

	current := absPath
	if stat, err := os.Stat(absPath); err == nil && !stat.IsDir() {
		current = filepath.Dir(absPath)
	}

	for {
		gitMarker := filepath.Join(current, ".git")
		if _, err := os.Stat(gitMarker); err == nil {
			return current, nil
		}

		parent := filepath.Dir(current)
		if parent == current {
			break
		}
		current = parent
	}

	return "", fmt.Errorf("no git repository root found from %q", absPath)
}

func cloneGitRepo(src, dst string) error {
	cmd := exec.Command("git", "clone", "--local", "--no-hardlinks", src, dst)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("failed to prepare clean git mount from %q: %s", src, strings.TrimSpace(string(out)))
	}
	return nil
}

func copyRepoWorkingTree(src, dst string) error {
	if err := os.MkdirAll(filepath.Dir(dst), 0755); err != nil {
		return fmt.Errorf("failed to create no-clean parent for %q: %w", dst, err)
	}
	cmd := exec.Command("cp", "-a", src, dst)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("failed to prepare no-clean git mount from %q: %s", src, strings.TrimSpace(string(out)))
	}
	if _, err := os.Stat(filepath.Join(dst, ".git")); err != nil {
		return fmt.Errorf("failed to prepare no-clean git mount from %q: missing .git in %q", src, dst)
	}
	return nil
}

func syncGitRemotes(srcRepo, dstRepo string) error {
	srcRemotes, err := listGitRemotes(srcRepo)
	if err != nil {
		return fmt.Errorf("failed to read remotes from source repo %q: %w", srcRepo, err)
	}
	filtered := make(map[string]string)
	for name, url := range srcRemotes {
		if isNetworkRemoteURL(url) {
			filtered[name] = url
		}
	}

	dstRemotes, err := listGitRemotes(dstRepo)
	if err != nil {
		return fmt.Errorf("failed to read remotes from prepared repo %q: %w", dstRepo, err)
	}
	for _, name := range sortedRemoteNames(dstRemotes) {
		if err := runGit(dstRepo, "remote", "remove", name); err != nil {
			return fmt.Errorf("failed to remove remote %q from prepared repo %q: %w", name, dstRepo, err)
		}
	}
	for _, name := range sortedRemoteNames(filtered) {
		if err := runGit(dstRepo, "remote", "add", name, filtered[name]); err != nil {
			return fmt.Errorf("failed to add remote %q to prepared repo %q: %w", name, dstRepo, err)
		}
	}
	return nil
}

func listGitRemotes(repo string) (map[string]string, error) {
	out, err := runGitOutput(repo, "remote")
	if err != nil {
		return nil, err
	}
	names := strings.Fields(strings.TrimSpace(out))
	remotes := make(map[string]string, len(names))
	for _, name := range names {
		url, err := runGitOutput(repo, "remote", "get-url", name)
		if err != nil {
			return nil, err
		}
		remotes[name] = strings.TrimSpace(url)
	}
	return remotes, nil
}

func isNetworkRemoteURL(url string) bool {
	switch {
	case strings.HasPrefix(url, "http://"),
		strings.HasPrefix(url, "https://"),
		strings.HasPrefix(url, "ssh://"):
		return true
	case strings.HasPrefix(url, "file://"):
		return false
	}
	// Accept scp-like SSH syntax: user@host:path/to/repo.git
	at := strings.Index(url, "@")
	colon := strings.Index(url, ":")
	return at > 0 && colon > at+1
}

func sortedRemoteNames(m map[string]string) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

func runGit(repo string, args ...string) error {
	_, err := runGitOutput(repo, args...)
	return err
}

func runGitOutput(repo string, args ...string) (string, error) {
	cmdArgs := append([]string{"-C", repo}, args...)
	cmd := exec.Command("git", cmdArgs...)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("git %s failed: %s", strings.Join(args, " "), strings.TrimSpace(string(out)))
	}
	return string(out), nil
}

func promptForConfirmation(reader *bufio.Reader) (bool, error) {
	for {
		fmt.Print("Continue? [y/n] ")
		answer, err := reader.ReadString('\n')
		if err != nil {
			return false, fmt.Errorf("failed to read confirmation: %w", err)
		}
		answer = strings.TrimSpace(strings.ToLower(answer))
		switch answer {
		case "y", "yes":
			return true, nil
		case "n", "no":
			return false, nil
		case "":
			fmt.Println("Please enter 'y' or 'n'.")
		default:
			fmt.Println("Invalid response. Please enter 'y' or 'n'.")
		}
	}
}

func generateRWCopyVolumeName(sandboxName, target string) string {
	sanitizedTarget := strings.NewReplacer("/", "-", "_", "-", ".", "-").Replace(strings.TrimPrefix(target, "/"))
	if sanitizedTarget == "" {
		sanitizedTarget = "root"
	}
	return "amika-rwcopy-" + sandboxName + "-" + sanitizedTarget + "-" + strconv.FormatInt(time.Now().UnixNano(), 10)
}

func generateRWCopyFileMountName(sandboxName, target string) string {
	sanitizedTarget := strings.NewReplacer("/", "-", "_", "-", ".", "-").Replace(strings.TrimPrefix(target, "/"))
	if sanitizedTarget == "" {
		sanitizedTarget = "root"
	}
	return "amika-rwcopy-file-" + sandboxName + "-" + sanitizedTarget + "-" + strconv.FormatInt(time.Now().UnixNano(), 10)
}

func copyFile(src, dst string) error {
	srcInfo, err := os.Stat(src)
	if err != nil {
		return fmt.Errorf("failed to stat source file %q: %w", src, err)
	}
	data, err := os.ReadFile(src)
	if err != nil {
		return fmt.Errorf("failed to read source file %q: %w", src, err)
	}
	if err := os.WriteFile(dst, data, srcInfo.Mode()); err != nil {
		return fmt.Errorf("failed to write destination file %q: %w", dst, err)
	}
	return nil
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

func cleanupSandboxFileMounts(
	fileMountStore sandbox.FileMountStore,
	sandboxName string,
	deleteMounts bool,
) ([]string, error) {
	mounts, err := fileMountStore.FileMountsForSandbox(sandboxName)
	if err != nil {
		return nil, fmt.Errorf("failed to load associated file mounts: %w", err)
	}
	if len(mounts) == 0 {
		return nil, nil
	}

	statuses := make([]string, 0, len(mounts))
	var errs []string

	for _, fm := range mounts {
		if err := fileMountStore.RemoveSandboxRef(fm.Name, sandboxName); err != nil {
			statuses = append(statuses, fmt.Sprintf("file-mount %s: delete-failed: failed to update refs", fm.Name))
			errs = append(errs, fmt.Sprintf("failed to remove sandbox ref for file mount %q: %v", fm.Name, err))
			continue
		}

		if !deleteMounts {
			statuses = append(statuses, fmt.Sprintf("file-mount %s: preserved", fm.Name))
			continue
		}

		inUse, err := fileMountStore.IsInUse(fm.Name)
		if err != nil {
			statuses = append(statuses, fmt.Sprintf("file-mount %s: delete-failed: failed to check usage", fm.Name))
			errs = append(errs, fmt.Sprintf("failed to check usage for file mount %q: %v", fm.Name, err))
			continue
		}
		if inUse {
			statuses = append(statuses, fmt.Sprintf("file-mount %s: preserved (still referenced)", fm.Name))
			continue
		}

		if err := os.RemoveAll(filepath.Dir(fm.CopyPath)); err != nil {
			statuses = append(statuses, fmt.Sprintf("file-mount %s: delete-failed: %v", fm.Name, err))
			errs = append(errs, fmt.Sprintf("failed to delete file mount directory for %q: %v", fm.Name, err))
			continue
		}
		if err := fileMountStore.Remove(fm.Name); err != nil {
			statuses = append(statuses, fmt.Sprintf("file-mount %s: delete-failed: failed to remove state entry", fm.Name))
			errs = append(errs, fmt.Sprintf("failed to remove file mount state for %q: %v", fm.Name, err))
			continue
		}
		statuses = append(statuses, fmt.Sprintf("file-mount %s: deleted", fm.Name))
	}

	if len(errs) > 0 {
		return statuses, fmt.Errorf("%s", strings.Join(errs, "; "))
	}
	return statuses, nil
}

func validateDeleteVolumeFlags(
	deleteVolumesSet bool,
	deleteVolumes bool,
	keepVolumesSet bool,
	keepVolumes bool,
) error {
	if deleteVolumesSet && !deleteVolumes {
		return fmt.Errorf("--delete-volumes does not accept an explicit value; use --delete-volumes or omit the flag")
	}
	if keepVolumesSet && !keepVolumes {
		return fmt.Errorf("--keep-volumes does not accept an explicit value; use --keep-volumes or omit the flag")
	}
	if deleteVolumesSet && keepVolumesSet {
		return fmt.Errorf("cannot use --delete-volumes and --keep-volumes together")
	}
	return nil
}

// resolveDeleteVolumes determines whether sandbox delete should remove volumes.
// Precedence is:
//  1. --delete-volumes
//  2. --keep-volumes
//  3. no explicit flag: prompt only when this sandbox is the sole ref for any
//     attached volume.
func resolveDeleteVolumes(
	volumeStore sandbox.VolumeStore,
	fileMountStore sandbox.FileMountStore,
	sandboxName string,
	deleteVolumesSet bool,
	keepVolumesSet bool,
	reader *bufio.Reader,
) (bool, error) {
	if deleteVolumesSet {
		return true, nil
	}
	if keepVolumesSet {
		return false, nil
	}

	volumes, err := volumeStore.VolumesForSandbox(sandboxName)
	if err != nil {
		return false, fmt.Errorf("failed to load associated volumes: %w", err)
	}

	var exclusive []string
	for _, volume := range volumes {
		exclusiveToSandbox := true
		for _, ref := range volume.SandboxRefs {
			if ref != sandboxName {
				exclusiveToSandbox = false
				break
			}
		}
		if exclusiveToSandbox {
			exclusive = append(exclusive, volume.Name)
		}
	}

	fileMounts, err := fileMountStore.FileMountsForSandbox(sandboxName)
	if err != nil {
		return false, fmt.Errorf("failed to load associated file mounts: %w", err)
	}
	for _, fm := range fileMounts {
		exclusiveToSandbox := true
		for _, ref := range fm.SandboxRefs {
			if ref != sandboxName {
				exclusiveToSandbox = false
				break
			}
		}
		if exclusiveToSandbox {
			exclusive = append(exclusive, fm.Name)
		}
	}

	if len(exclusive) == 0 {
		return false, nil
	}

	fmt.Printf("Sandbox %q is the only user of volumes: %s\n", sandboxName, strings.Join(exclusive, ", "))
	fmt.Println("Delete these volumes as part of sandbox deletion?")
	confirmed, err := promptForConfirmation(reader)
	if err != nil {
		return false, err
	}
	return confirmed, nil
}

func init() {
	rootCmd.AddCommand(sandboxCmd)
	sandboxCmd.AddCommand(sandboxCreateCmd)
	sandboxCmd.AddCommand(sandboxDeleteCmd)
	sandboxCmd.AddCommand(sandboxListCmd)
	sandboxCmd.AddCommand(sandboxConnectCmd)

	// Create flags
	sandboxCreateCmd.Flags().String("provider", "docker", "Sandbox provider")
	sandboxCreateCmd.Flags().String("name", "", "Name for the sandbox (auto-generated if not set)")
	sandboxCreateCmd.Flags().String("image", sandbox.DefaultCoderImage, "Docker image to use")
	sandboxCreateCmd.Flags().String("preset", "", "Use a preset environment (e.g. \"coder\" or \"claude\")")
	sandboxCreateCmd.Flags().StringArray("mount", nil, "Mount a host directory (source:target[:mode], mode defaults to rwcopy)")
	sandboxCreateCmd.Flags().StringArray("volume", nil, "Mount an existing named volume (name:target[:mode], mode defaults to rw)")
	sandboxCreateCmd.Flags().String("git", "", "Mount the current git repo root (or repo containing PATH) into /home/amika/workspace/{repo}")
	sandboxCreateCmd.Flags().Lookup("git").NoOptDefVal = "."
	sandboxCreateCmd.Flags().Bool("no-clean", false, "With --git, include untracked files from working tree instead of a clean clone")
	sandboxCreateCmd.Flags().StringArray("env", nil, "Set environment variable (KEY=VALUE)")
	sandboxCreateCmd.Flags().Bool("yes", false, "Skip mount confirmation prompt")
	sandboxCreateCmd.Flags().Bool("connect", false, "Connect to the sandbox shell immediately after creation")
	sandboxDeleteCmd.Flags().Bool("delete-volumes", false, "Also delete associated volumes that are no longer referenced")
	sandboxDeleteCmd.Flags().Bool("keep-volumes", false, "Keep associated volumes even when only this sandbox references them")
	sandboxConnectCmd.Flags().String("shell", "zsh", "Shell to run in the sandbox container")

}

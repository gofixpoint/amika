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
	"syscall"
	"text/tabwriter"
	"time"

	"github.com/gofixpoint/amika/internal/agentconfig"
	"github.com/gofixpoint/amika/internal/amikaconfig"
	"github.com/gofixpoint/amika/internal/apiclient"
	"github.com/gofixpoint/amika/internal/auth"
	"github.com/gofixpoint/amika/internal/config"
	"github.com/gofixpoint/amika/internal/constants"
	"github.com/gofixpoint/amika/internal/sandbox"
	"github.com/gofixpoint/amika/internal/txn"
	"github.com/gofixpoint/amika/pkg/amika"
	"github.com/spf13/cobra"
)

var sandboxCmd = &cobra.Command{
	Use:   "sandbox",
	Short: "Manage sandboxes",
	Long:  `Create and delete sandboxed environments backed by container providers.`,
}

const sandboxConnectWorkdir = "/home/amika"

// TODO: Parse env variables from an environment file (e.g. .amika/.env or ~/.config/amika/env)
// so users don't need to export AMIKA_API_URL, AMIKA_WORKOS_CLIENT_ID, etc. in their shell profile.

// sandboxMode determines whether a command operates locally, remotely, or both.
// Returns "local", "remote", or "both".
func sandboxMode(cmd *cobra.Command) string {
	local, _ := cmd.Flags().GetBool("local")
	remote, _ := cmd.Flags().GetBool("remote")
	remoteTarget, _ := cmd.Flags().GetString("remote-target")
	if local {
		return "local"
	}
	if remote || remoteTarget != "" {
		return "remote"
	}
	// Default: if logged in with a valid session, include remote; otherwise local.
	// GetValidSession refreshes expired tokens; if that fails the session is
	// unusable and we fall back to local-only without blocking the command.
	if _, err := auth.GetValidSession(config.WorkOSClientID()); err != nil {
		return "local"
	}
	return "both"
}

// isLoggedIn returns true if a valid (or refreshable) WorkOS session exists.
func isLoggedIn() bool {
	_, err := auth.GetValidSession(config.WorkOSClientID())
	return err == nil
}

// printLocalOnlyNotice prints a notice when the user is not logged in and
// no explicit --local flag was set.
func printLocalOnlyNotice(cmd *cobra.Command) {
	local, _ := cmd.Flags().GetBool("local")
	if !local && !isLoggedIn() {
		fmt.Fprintln(cmd.ErrOrStderr(), "Note: showing local resources only. Run \"amika auth login\" to access remote sandboxes.")
	}
}

// getRemoteTarget validates that --remote-target is not combined with --local or --remote, and returns the target string.
// The flag is currently hidden and disabled; it will be enabled once named-remote config is implemented.
func getRemoteTarget(cmd *cobra.Command) (string, error) {
	target, _ := cmd.Flags().GetString("remote-target")
	if target != "" {
		return "", fmt.Errorf("--remote-target is not yet supported")
	}
	return target, nil
}

// getRemoteClient returns an API client authenticated with the current session.
// If AMIKA_API_KEY is set, it is used as a static bearer token instead of the WorkOS session.
func getRemoteClient(target string) (*apiclient.Client, error) {
	// TODO: when named-remote config is added, look up target here.
	_ = target
	if apiKey := os.Getenv("AMIKA_API_KEY"); apiKey != "" {
		return apiclient.NewClient(config.APIURL(), apiKey), nil
	}
	return apiclient.NewClientWithTokenSource(config.APIURL(), apiclient.NewWorkOSTokenSource(config.WorkOSClientID())), nil
}

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

		// Validate flag constraints before any network or auth calls.
		noClean, _ := cmd.Flags().GetBool("no-clean")
		gitFlagChanged := cmd.Flags().Changed("git")
		if err := validateGitFlags(gitFlagChanged, noClean); err != nil {
			return err
		}

		target, err := getRemoteTarget(cmd)
		if err != nil {
			return err
		}

		mode := sandboxMode(cmd)
		if mode == "remote" || mode == "both" {
			return createRemoteSandbox(cmd, target)
		}
		printLocalOnlyNotice(cmd)

		provider, _ := cmd.Flags().GetString("provider")
		name, _ := cmd.Flags().GetString("name")
		image, _ := cmd.Flags().GetString("image")
		preset, _ := cmd.Flags().GetString("preset")
		mountStrs, _ := cmd.Flags().GetStringArray("mount")
		volumeStrs, _ := cmd.Flags().GetStringArray("volume")
		gitPath, _ := cmd.Flags().GetString("git")
		envStrs, _ := cmd.Flags().GetStringArray("env")
		portStrs, _ := cmd.Flags().GetStringArray("port")
		portHostIP, _ := cmd.Flags().GetString("port-host-ip")
		yes, _ := cmd.Flags().GetBool("yes")
		connect, _ := cmd.Flags().GetBool("connect")
		setupScript, _ := cmd.Flags().GetString("setup-script")

		if provider != "docker" {
			return fmt.Errorf("unsupported provider %q: only \"docker\" is supported", provider)
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

		collected, err := collectMounts(mountStrs, volumeStrs, portStrs, portHostIP,
			gitPath, gitFlagChanged, noClean,
			setupScript, cmd.Flags().Changed("setup-script"))
		if err != nil {
			return err
		}
		defer collected.Cleanup()
		mounts := collected.Mounts
		volumeMounts := collected.VolumeMounts
		publishedPorts := collected.Ports
		gitMountInfo := collected.GitInfo
		if gitMountInfo != nil && !hasEnvKey(envStrs, "AMIKA_AGENT_CWD") {
			envStrs = append(envStrs, "AMIKA_AGENT_CWD="+gitMountInfo.Mount.Target)
		}
		envStrs = appendPresetRuntimeEnv(envStrs)
		if !hasEnvKey(envStrs, constants.EnvSandboxProvider) {
			envStrs = append(envStrs, constants.EnvSandboxProvider+"="+constants.ProviderLocalDocker)
		}

		// Resolve provisioned (Amika-managed) services such as the OpenCode web
		// UI. These run on reserved ports inside the container and need explicit
		// Docker port bindings. Must run after appendPresetRuntimeEnv so
		// OPENCODE_SERVER_PASSWORD is present in envStrs.
		provSvcInfos, provPorts, err := amika.ResolveProvisionedServices(envStrs, publishedPorts, portHostIP)
		if err != nil {
			return err
		}
		collected.Services = append(collected.Services, provSvcInfos...)
		publishedPorts = append(publishedPorts, provPorts...)

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
			generated, err := sandbox.GenerateUniqueName(store)
			if err != nil {
				return err
			}
			name = generated
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

		runtimeMounts, rb, err := materializeRWCopyMounts(mounts, name, volumeStore, fileMountStore, fileMountsBaseDir)
		if err != nil {
			return err
		}

		attachedVolumeRefs := make([]string, 0)
		rollbackVolumes := func() {
			for _, volumeName := range attachedVolumeRefs {
				_ = volumeStore.RemoveSandboxRef(volumeName, name)
			}
			rb.Rollback()
		}

		for _, v := range volumeMounts {
			if _, err := volumeStore.Get(v.Volume); err != nil {
				rollbackVolumes()
				return fmt.Errorf("volume %q is not tracked; create via rwcopy first", v.Volume)
			}
			if err := volumeStore.AddSandboxRef(v.Volume, name); err != nil {
				rollbackVolumes()
				return fmt.Errorf("failed to attach volume %q: %w", v.Volume, err)
			}
			attachedVolumeRefs = append(attachedVolumeRefs, v.Volume)
			runtimeMounts = append(runtimeMounts, v)
		}

		containerID, err := sandbox.CreateDockerSandbox(name, image, runtimeMounts, envStrs, publishedPorts)
		if err != nil {
			rollbackVolumes()
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
			Ports:       publishedPorts,
			Services:    collected.Services,
		}
		if err := store.Save(info); err != nil {
			return fmt.Errorf("sandbox created but failed to save state: %w", err)
		}
		rb.Disarm()

		fmt.Printf("Sandbox %q created (container %s)\n", name, containerID[:12])
		if len(publishedPorts) > 0 {
			fmt.Println("Published ports:")
			for _, p := range publishedPorts {
				fmt.Printf("  %s\n", formatPortBinding(p))
			}
		}
		if len(collected.Services) > 0 {
			fmt.Println("Services:")
			for _, svc := range collected.Services {
				for _, sp := range svc.Ports {
					url := "-"
					if sp.URL != "" {
						url = sp.URL
					}
					fmt.Printf("  %s: %s (url: %s)\n", svc.Name, formatPortBinding(sp.PortBinding), url)
				}
			}
		}
		if connect {
			if err := runSandboxConnect(name, "zsh", os.Stdin, os.Stdout, os.Stderr); err != nil {
				return fmt.Errorf("sandbox %q created but failed to connect with shell %q: %w", name, "zsh", err)
			}
		}
		return nil
	},
}

var sandboxStopCmd = &cobra.Command{
	Use:   "stop <name> [<name>...]",
	Short: "Stop one or more sandboxes",
	Long:  `Stop one or more running sandboxes without removing them.`,
	Args:  cobra.MinimumNArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		cmd.SilenceUsage = true

		target, err := getRemoteTarget(cmd)
		if err != nil {
			return err
		}

		mode := sandboxMode(cmd)

		sandboxesFile, err := config.SandboxesStateFile()
		if err != nil {
			return err
		}
		store := sandbox.NewStore(sandboxesFile)

		var remoteClient *apiclient.Client
		if mode == "remote" || mode == "both" {
			remoteClient, err = getRemoteClient(target)
			if err != nil {
				return err
			}
		}

		var errs []string
		for _, name := range args {
			// Remote-only mode: skip local entirely.
			if mode == "remote" {
				if remoteClient != nil {
					if remoteErr := remoteClient.StopSandbox(name); remoteErr != nil {
						errs = append(errs, fmt.Sprintf("sandbox %q: %v", name, remoteErr))
					} else {
						fmt.Printf("Sandbox %q stopped (remote)\n", name)
					}
				}
				continue
			}

			info, localErr := store.Get(name)
			if localErr != nil && mode == "both" && remoteClient != nil {
				// Not found locally, try remote.
				if remoteErr := remoteClient.StopSandbox(name); remoteErr != nil {
					errs = append(errs, fmt.Sprintf("sandbox %q: %v", name, remoteErr))
				} else {
					fmt.Printf("Sandbox %q stopped (remote)\n", name)
				}
				continue
			}
			if localErr != nil {
				errs = append(errs, fmt.Sprintf("sandbox %q not found", name))
				continue
			}

			if info.Provider == "docker" {
				if err := sandbox.StopDockerSandbox(name); err != nil {
					errs = append(errs, fmt.Sprintf("sandbox %q: %v", name, err))
					continue
				}
			}

			fmt.Printf("Sandbox %q stopped\n", name)
		}
		if len(errs) > 0 {
			return fmt.Errorf("%s", strings.Join(errs, "\n"))
		}
		return nil
	},
}

var sandboxDeleteCmd = &cobra.Command{
	Use:     "delete <name> [<name>...]",
	Aliases: []string{"rm", "remove"},
	Short:   "Delete one or more sandboxes",
	Long:    `Delete one or more sandboxes and remove their backing containers.`,
	Args:    cobra.MinimumNArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		force, _ := cmd.Flags().GetBool("force")

		if !force {
			reader := bufio.NewReader(cmd.InOrStdin())
			confirmed, err := confirmAction(
				fmt.Sprintf("Delete sandbox(es) %s?", strings.Join(args, ", ")),
				reader,
			)
			if err != nil {
				return err
			}
			if !confirmed {
				fmt.Println("Aborted.")
				return nil
			}
		}

		target, err := getRemoteTarget(cmd)
		if err != nil {
			return err
		}

		mode := sandboxMode(cmd)

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

		// Build a remote client if we may need it.
		var remoteClient *apiclient.Client
		if mode == "remote" || mode == "both" {
			remoteClient, err = getRemoteClient(target)
			if err != nil {
				return err
			}
		}

		var errs []string
		for _, name := range args {
			// Remote-only mode: skip local entirely.
			if mode == "remote" {
				if remoteClient != nil {
					if remoteErr := remoteClient.DeleteSandbox(name); remoteErr != nil {
						errs = append(errs, fmt.Sprintf("sandbox %q: %v", name, remoteErr))
					} else {
						fmt.Printf("Sandbox %q deleted (remote)\n", name)
					}
				}
				continue
			}

			info, localErr := store.Get(name)
			if localErr != nil && mode == "both" && remoteClient != nil {
				// Not found locally, try remote.
				if remoteErr := remoteClient.DeleteSandbox(name); remoteErr != nil {
					errs = append(errs, fmt.Sprintf("sandbox %q: %v", name, remoteErr))
				} else {
					fmt.Printf("Sandbox %q deleted (remote)\n", name)
				}
				continue
			}
			if localErr != nil {
				errs = append(errs, fmt.Sprintf("sandbox %q not found", name))
				continue
			}

			deleteVols, err := resolveDeleteVolumes(
				volumeStore,
				fileMountStore,
				name,
				deleteVolumesSet,
				keepVolumesSet,
				bufio.NewReader(cmd.InOrStdin()),
			)
			if err != nil {
				errs = append(errs, fmt.Sprintf("sandbox %q: %v", name, err))
				continue
			}

			if info.Provider == "docker" {
				if err := sandbox.RemoveDockerSandbox(name); err != nil {
					errs = append(errs, fmt.Sprintf("sandbox %q: %v", name, err))
					continue
				}
			}

			volumeStatuses, volumeErr := cleanupSandboxVolumes(volumeStore, name, deleteVols, sandbox.RemoveDockerVolume)
			fileMountStatuses, fileMountErr := cleanupSandboxFileMounts(fileMountStore, name, deleteVols)

			if err := store.Remove(name); err != nil {
				errs = append(errs, fmt.Sprintf("sandbox %q: container removed but failed to update state: %v", name, err))
				continue
			}

			fmt.Printf("Sandbox %q deleted\n", name)
			for _, line := range volumeStatuses {
				fmt.Println(line)
			}
			for _, line := range fileMountStatuses {
				fmt.Println(line)
			}
			if volumeErr != nil {
				errs = append(errs, fmt.Sprintf("sandbox %q: %v", name, volumeErr))
			}
			if fileMountErr != nil {
				errs = append(errs, fmt.Sprintf("sandbox %q: %v", name, fileMountErr))
			}
		}
		if len(errs) > 0 {
			return fmt.Errorf("%s", strings.Join(errs, "\n"))
		}
		return nil
	},
}

var sandboxListCmd = &cobra.Command{
	Use:   "list",
	Short: "List all sandboxes",
	Args:  cobra.NoArgs,
	RunE: func(cmd *cobra.Command, _ []string) error {
		target, err := getRemoteTarget(cmd)
		if err != nil {
			return err
		}

		mode := sandboxMode(cmd)
		printLocalOnlyNotice(cmd)

		var allItems []amika.Sandbox

		if mode == "local" || mode == "both" {
			result, err := amika.NewService(amika.Options{}).ListSandboxes(cmd.Context(), amika.ListSandboxesRequest{})
			if err != nil {
				return err
			}
			for i := range result.Items {
				result.Items[i].Location = "local"
				if result.Items[i].Provider == "docker" {
					state, err := sandbox.GetDockerContainerState(result.Items[i].Name)
					if err != nil {
						result.Items[i].State = "unknown"
					} else {
						result.Items[i].State = state
					}
				}
			}
			allItems = append(allItems, result.Items...)
		}

		if mode == "remote" || mode == "both" {
			client, err := getRemoteClient(target)
			if err != nil {
				return err
			}
			remoteSandboxes, err := client.ListSandboxes()
			if err != nil {
				return err
			}
			for _, rs := range remoteSandboxes {
				allItems = append(allItems, amika.Sandbox{
					Name:      rs.Name,
					State:     rs.State,
					Provider:  rs.Provider,
					CreatedAt: rs.CreatedAt,
					Location:  "remote",
				})
			}
		}

		if len(allItems) == 0 {
			fmt.Println("No sandboxes found.")
			return nil
		}

		w := tabwriter.NewWriter(cmd.OutOrStdout(), 0, 4, 2, ' ', 0)
		fmt.Fprintln(w, "NAME\tSTATE\tLOCATION\tPROVIDER\tIMAGE\tPORTS\tCREATED")
		for _, sb := range allItems {
			fmt.Fprintf(w, "%s\t%s\t%s\t%s\t%s\t%s\t%s\n", sb.Name, sb.State, sb.Location, sb.Provider, sb.Image, formatPortBindings(sb.Ports), sb.CreatedAt)
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

		// Try local sandbox first.
		sandboxesFile, err := config.SandboxesStateFile()
		if err == nil {
			store := sandbox.NewStore(sandboxesFile)
			if info, err := store.Get(name); err == nil {
				if info.Provider != "docker" {
					return fmt.Errorf("unsupported local provider %q: only \"docker\" is supported", info.Provider)
				}
				if err := runSandboxConnect(name, shell, os.Stdin, os.Stdout, os.Stderr); err != nil {
					return fmt.Errorf("failed to connect to sandbox %q with shell %q: %w", name, shell, err)
				}
				return nil
			}
		}

		// Not found locally — try remote SSH.
		target, err := getRemoteTarget(cmd)
		if err != nil {
			return err
		}

		client, err := getRemoteClient(target)
		if err != nil {
			return err
		}

		info, err := client.GetSSH(name)
		if err != nil {
			return err
		}

		if info.SSHDestination == "" {
			return fmt.Errorf("server returned empty SSH destination")
		}

		sshArgs := strings.Fields(info.SSHDestination)

		// Use syscall.Exec to replace this process with ssh, so that
		// stdin/stdout/stderr and signals pass through directly with no
		// intermediary process.
		sshBin, err := exec.LookPath("ssh")
		if err != nil {
			return fmt.Errorf("ssh not found: %w", err)
		}
		// argv[0] must be the program name.
		return syscall.Exec(sshBin, append([]string{"ssh"}, sshArgs...), os.Environ())
	},
}

// parsePortFlags parses --port flag values in the format hostPort:containerPort[/protocol].
func parsePortFlags(flags []string, hostIP string) ([]sandbox.PortBinding, error) {
	hostIP = strings.TrimSpace(hostIP)
	if hostIP == "" {
		return nil, fmt.Errorf("--port-host-ip must not be empty")
	}

	ports := make([]sandbox.PortBinding, 0, len(flags))
	seen := make(map[string]bool, len(flags))
	for _, raw := range flags {
		value := strings.TrimSpace(raw)
		if value == "" {
			return nil, fmt.Errorf("invalid port format %q: expected hostPort:containerPort[/protocol]", raw)
		}

		mainPart := value
		protocol := "tcp"
		if strings.Contains(value, "/") {
			parts := strings.SplitN(value, "/", 2)
			mainPart = parts[0]
			protocol = strings.ToLower(strings.TrimSpace(parts[1]))
		}
		if protocol != "tcp" && protocol != "udp" {
			return nil, fmt.Errorf("invalid port protocol %q: must be \"tcp\" or \"udp\"", protocol)
		}

		parts := strings.SplitN(mainPart, ":", 2)
		if len(parts) != 2 {
			return nil, fmt.Errorf("invalid port format %q: expected hostPort:containerPort[/protocol]", raw)
		}
		hostPort, err := strconv.Atoi(strings.TrimSpace(parts[0]))
		if err != nil {
			return nil, fmt.Errorf("invalid host port in %q: %w", raw, err)
		}
		containerPort, err := strconv.Atoi(strings.TrimSpace(parts[1]))
		if err != nil {
			return nil, fmt.Errorf("invalid container port in %q: %w", raw, err)
		}
		if hostPort < 1 || hostPort > 65535 {
			return nil, fmt.Errorf("host port %d must be between 1 and 65535", hostPort)
		}
		if containerPort < 1 || containerPort > 65535 {
			return nil, fmt.Errorf("container port %d must be between 1 and 65535", containerPort)
		}

		key := fmt.Sprintf("%s:%d/%s", hostIP, hostPort, protocol)
		if seen[key] {
			return nil, fmt.Errorf("duplicate published port binding %s", key)
		}
		seen[key] = true
		ports = append(ports, sandbox.PortBinding{
			HostIP:        hostIP,
			HostPort:      hostPort,
			ContainerPort: containerPort,
			Protocol:      protocol,
		})
	}
	return ports, nil
}

func formatPortBindings(bindings []amika.PortBinding) string {
	if len(bindings) == 0 {
		return "-"
	}
	out := make([]string, 0, len(bindings))
	for _, p := range bindings {
		hostIP := p.HostIP
		if strings.TrimSpace(hostIP) == "" {
			hostIP = "127.0.0.1"
		}
		protocol := p.Protocol
		if strings.TrimSpace(protocol) == "" {
			protocol = "tcp"
		}
		out = append(out, fmt.Sprintf("%s:%d->%d/%s", hostIP, p.HostPort, p.ContainerPort, protocol))
	}
	return strings.Join(out, ",")
}

func formatPortBinding(binding sandbox.PortBinding) string {
	hostIP := binding.HostIP
	if strings.TrimSpace(hostIP) == "" {
		hostIP = "127.0.0.1"
	}
	protocol := binding.Protocol
	if strings.TrimSpace(protocol) == "" {
		protocol = "tcp"
	}
	return fmt.Sprintf("%s:%d->%d/%s", hostIP, binding.HostPort, binding.ContainerPort, protocol)
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

func confirmAction(message string, reader *bufio.Reader) (bool, error) {
	for {
		fmt.Printf("%s [y/n] ", message)
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

// collectedMounts holds all mounts and related data gathered from CLI flags,
// git, agent credentials, and setup-script before materialization.
type collectedMounts struct {
	Mounts       []sandbox.MountBinding
	VolumeMounts []sandbox.MountBinding
	Ports        []sandbox.PortBinding
	Services     []sandbox.ServiceInfo // resolved service port bindings
	GitInfo      *gitMountInfo         // nil if --git was not used
	Cleanup      func()                // removes git temp dir; noop if no --git
}

// collectMounts gathers all mounts from CLI flags, git clone, .amika/config.toml,
// agent credentials, and setup-script. Call Cleanup (e.g. via defer) to remove any
// temporary directories created for the git mount.
func collectMounts(
	mountStrs, volumeStrs, portStrs []string,
	portHostIP string,
	gitPath string,
	gitFlagChanged bool,
	noClean bool,
	setupScript string,
	setupScriptFlagChanged bool,
) (collectedMounts, error) {
	mounts, err := parseMountFlags(mountStrs)
	if err != nil {
		return collectedMounts{}, err
	}
	volumeMounts, err := parseVolumeFlags(volumeStrs)
	if err != nil {
		return collectedMounts{}, err
	}
	publishedPorts, err := parsePortFlags(portStrs, portHostIP)
	if err != nil {
		return collectedMounts{}, err
	}

	cleanup := func() {}
	var gmi *gitMountInfo
	if gitFlagChanged {
		info, cleanupGitMount, err := prepareGitMount(gitPath, noClean, cloneGitRepo)
		if err != nil {
			return collectedMounts{}, err
		}
		cleanup = cleanupGitMount
		gmi = &info
		mounts = append(mounts, info.Mount)
	}

	// Load .amika/config.toml once from the repo root for both setup script and services.
	var repoCfg *amikaconfig.Config
	if gmi != nil {
		repoCfg, err = amikaconfig.LoadConfig(gmi.RepoRoot)
		if err != nil {
			cleanup()
			return collectedMounts{}, fmt.Errorf("failed to read .amika/config.toml: %w", err)
		}
	}

	if repoCfg != nil && !setupScriptFlagChanged {
		mount, err := setupScriptMountFromLoadedConfig(repoCfg, gmi.RepoRoot)
		if err != nil {
			cleanup()
			return collectedMounts{}, err
		}
		if mount != nil {
			mounts = append(mounts, *mount)
		}
	}

	// Resolve service ports from config.
	var serviceInfos []sandbox.ServiceInfo
	if repoCfg != nil {
		svcInfos, additionalPorts, err := amika.ResolveServicesFromConfig(repoCfg, publishedPorts, portHostIP)
		if err != nil {
			cleanup()
			return collectedMounts{}, err
		}
		serviceInfos = svcInfos
		publishedPorts = append(publishedPorts, additionalPorts...)
	}

	if homeDir, err := os.UserHomeDir(); err == nil {
		agentMounts := agentconfig.RWCopyMounts(agentconfig.AllMounts(homeDir))
		mounts = append(mounts, agentMounts...)
	}

	if setupScript != "" {
		absSetupScript, err := filepath.Abs(setupScript)
		if err != nil {
			cleanup()
			return collectedMounts{}, fmt.Errorf("failed to resolve setup-script path %q: %w", setupScript, err)
		}
		if _, err := os.Stat(absSetupScript); err != nil {
			cleanup()
			return collectedMounts{}, fmt.Errorf("setup-script %q is not accessible: %w", absSetupScript, err)
		}
		mounts = append(mounts, setupScriptBindMount(absSetupScript))
	}

	return collectedMounts{
		Mounts:       mounts,
		VolumeMounts: volumeMounts,
		Ports:        publishedPorts,
		Services:     serviceInfos,
		GitInfo:      gmi,
		Cleanup:      cleanup,
	}, nil
}

// setupScriptMountFromLoadedConfig uses an already-loaded config to create a
// bind mount for lifecycle.setup_script if one is configured.
func setupScriptMountFromLoadedConfig(cfg *amikaconfig.Config, repoRoot string) (*sandbox.MountBinding, error) {
	if cfg == nil || cfg.Lifecycle.SetupScript == "" {
		return nil, nil
	}
	scriptPath := cfg.Lifecycle.SetupScript
	if !filepath.IsAbs(scriptPath) {
		scriptPath = filepath.Join(repoRoot, scriptPath)
	}
	if _, err := os.Stat(scriptPath); err != nil {
		return nil, fmt.Errorf("setup_script %q from .amika/config.toml is not accessible: %w", cfg.Lifecycle.SetupScript, err)
	}
	m := setupScriptBindMount(scriptPath)
	return &m, nil
}

// setupScriptBindMount returns a read-only bind mount for absPath to /usr/local/etc/amikad/setup/setup.sh.
func setupScriptBindMount(absPath string) sandbox.MountBinding {
	return sandbox.MountBinding{
		Type:   "bind",
		Source: absPath,
		Target: "/usr/local/etc/amikad/setup/setup.sh",
		Mode:   "ro",
	}
}

// materializeRWCopyMounts converts logical mounts that use mode "rwcopy" into
// real Docker volumes (for directory sources) or bind-mounted file copies (for
// file sources). Mounts with other modes are passed through unchanged.
//
// The returned Rollbacker must have Rollback called on any error path to undo
// partial state; call Disarm after the sandbox is successfully created.
func materializeRWCopyMounts(
	mounts []sandbox.MountBinding,
	sandboxName string,
	volumeStore sandbox.VolumeStore,
	fileMountStore sandbox.FileMountStore,
	fileMountsBaseDir string,
) ([]sandbox.MountBinding, txn.Rollbacker, error) {
	var runtimeMounts []sandbox.MountBinding
	createdVolumes := make([]string, 0)
	addedRefs := make(map[string]bool)
	createdFileMountDirs := make([]string, 0)
	addedFileRefs := make(map[string]bool)

	rb := txn.NewRollbacker(func() {
		for volumeName := range addedRefs {
			_ = volumeStore.RemoveSandboxRef(volumeName, sandboxName)
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
	})

	for _, m := range mounts {
		if m.Mode != "rwcopy" {
			runtimeMounts = append(runtimeMounts, m)
			continue
		}

		stat, err := os.Stat(m.Source)
		if err != nil {
			rb.Rollback()
			return nil, rb, fmt.Errorf("rwcopy source %q is not accessible: %w", m.Source, err)
		}

		if stat.IsDir() {
			volumeName := generateRWCopyVolumeName(sandboxName, m.Target)
			if err := sandbox.CreateDockerVolume(volumeName); err != nil {
				rb.Rollback()
				return nil, rb, err
			}
			createdVolumes = append(createdVolumes, volumeName)

			if err := sandbox.CopyHostDirToVolume(volumeName, m.Source); err != nil {
				rb.Rollback()
				return nil, rb, err
			}

			volInfo := sandbox.VolumeInfo{
				Name:        volumeName,
				CreatedAt:   time.Now().UTC().Format(time.RFC3339),
				CreatedBy:   "rwcopy",
				SourcePath:  m.Source,
				SandboxRefs: []string{sandboxName},
			}
			if err := volumeStore.Save(volInfo); err != nil {
				rb.Rollback()
				return nil, rb, fmt.Errorf("failed to save volume state for %q: %w", volumeName, err)
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
			mountName := generateRWCopyFileMountName(sandboxName, m.Target)
			copyDir := filepath.Join(fileMountsBaseDir, mountName)
			if err := os.MkdirAll(copyDir, 0755); err != nil {
				rb.Rollback()
				return nil, rb, fmt.Errorf("failed to create file mount directory for %q: %w", mountName, err)
			}
			createdFileMountDirs = append(createdFileMountDirs, copyDir)

			copyPath := filepath.Join(copyDir, filepath.Base(m.Source))
			if err := copyFile(m.Source, copyPath); err != nil {
				rb.Rollback()
				return nil, rb, fmt.Errorf("failed to copy file for rwcopy mount %q: %w", m.Source, err)
			}

			fmInfo := sandbox.FileMountInfo{
				Name:        mountName,
				Type:        "file",
				CreatedAt:   time.Now().UTC().Format(time.RFC3339),
				CreatedBy:   "rwcopy",
				SourcePath:  m.Source,
				CopyPath:    copyPath,
				SandboxRefs: []string{sandboxName},
			}
			if err := fileMountStore.Save(fmInfo); err != nil {
				rb.Rollback()
				return nil, rb, fmt.Errorf("failed to save file mount state for %q: %w", mountName, err)
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

	return runtimeMounts, rb, nil
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

func hasEnvKey(env []string, key string) bool {
	prefix := key + "="
	for _, e := range env {
		if strings.HasPrefix(e, prefix) {
			return true
		}
	}
	return false
}

func createRemoteSandbox(cmd *cobra.Command, target string) error {
	name, _ := cmd.Flags().GetString("name")
	gitValue, _ := cmd.Flags().GetString("git")

	var gitURL string
	if cmd.Flags().Changed("git") {
		resolved, err := resolveGitURL(gitValue)
		if err != nil {
			return err
		}
		gitURL = resolved
	}

	client, err := getRemoteClient(target)
	if err != nil {
		return err
	}

	req := apiclient.CreateSandboxRequest{
		Name:      name,
		Provider:  "daytona",
		GitHubURL: gitURL,
	}

	sb, err := client.CreateSandbox(req)
	if err != nil {
		return err
	}

	fmt.Fprintf(cmd.OutOrStdout(), "Sandbox %q created (remote)\n", sb.Name)
	return nil
}

// resolveGitURL takes the --git flag value and returns a git URL suitable for
// remote sandbox creation. If the value is already an HTTP(S) or SSH URL, it is
// returned directly. Otherwise it is treated as a local path and the origin
// remote URL is extracted.
func resolveGitURL(value string) (string, error) {
	// Already a URL — use as-is.
	if strings.HasPrefix(value, "http://") || strings.HasPrefix(value, "https://") || strings.HasPrefix(value, "git@") {
		return value, nil
	}

	// Treat as local path — derive from origin remote.
	repoRoot, err := resolveGitRoot(value)
	if err != nil {
		return "", fmt.Errorf("could not find git repo at %q: %w", value, err)
	}
	remotes, err := listGitRemotes(repoRoot)
	if err != nil {
		return "", err
	}
	origin, ok := remotes["origin"]
	if !ok {
		return "", fmt.Errorf("no origin remote found in %q; specify a git HTTP(S) or SSH URL directly with --git <url>", repoRoot)
	}
	if !isNetworkRemoteURL(origin) {
		return "", fmt.Errorf("origin remote %q is a local path; specify a git HTTP(S) or SSH URL directly with --git <url>", origin)
	}
	return origin, nil
}

var sandboxSSHCmd = &cobra.Command{
	Use:   "ssh <name> [-- <command>...]",
	Short: "SSH into a remote sandbox",
	Long: `Connect to a remote sandbox via SSH, or revoke SSH access.
Optionally pass a command to execute on the remote sandbox instead of opening an interactive session.

Use -t to force pseudo-terminal allocation, which is useful for running interactive
programs on the remote sandbox (equivalent to ssh -t).

Examples:
  amika sandbox ssh my-sandbox
  amika sandbox ssh -t my-sandbox -- top
  amika sandbox ssh my-sandbox -- ls -la
  amika sandbox ssh my-sandbox --revoke`,
	Args: cobra.MinimumNArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		cmd.SilenceUsage = true
		cmd.SilenceErrors = true

		name := args[0]

		// Check if this is a local sandbox.
		sandboxesFile, err := config.SandboxesStateFile()
		if err == nil {
			store := sandbox.NewStore(sandboxesFile)
			if _, err := store.Get(name); err == nil {
				return fmt.Errorf("SSH access currently only works for remote sandboxes; %q is a local sandbox", name)
			}
		}

		target, err := getRemoteTarget(cmd)
		if err != nil {
			return err
		}

		client, err := getRemoteClient(target)
		if err != nil {
			return err
		}

		revoke, _ := cmd.Flags().GetBool("revoke")
		if revoke {
			// Get the current SSH token, then revoke it.
			info, err := client.GetSSH(name)
			if err != nil {
				return err
			}
			if info.Token == "" {
				return fmt.Errorf("no SSH token to revoke for sandbox %q", name)
			}
			if err := client.RevokeSSH(name, info.Token); err != nil {
				return err
			}
			fmt.Fprintf(cmd.OutOrStdout(), "SSH access revoked for sandbox %q\n", name)
			return nil
		}

		info, err := client.GetSSH(name)
		if err != nil {
			return err
		}

		if info.SSHDestination == "" {
			return fmt.Errorf("server returned empty SSH destination")
		}

		// Parse destination and exec ssh.
		sshArgs := strings.Fields(info.SSHDestination)

		// Insert -t before the destination if pseudo-terminal allocation is requested.
		forcePTY, _ := cmd.Flags().GetBool("t")
		if forcePTY {
			// Insert -t before the last element (the destination host).
			dest := sshArgs[len(sshArgs)-1]
			sshArgs = append(sshArgs[:len(sshArgs)-1], "-t", dest)
		}

		// Append any extra arguments (commands to run remotely).
		if len(args) > 1 {
			sshArgs = append(sshArgs, args[1:]...)
		}

		// Use syscall.Exec to replace this process with ssh, so that
		// stdin/stdout/stderr and signals pass through directly with no
		// intermediary process.
		sshBin, err := exec.LookPath("ssh")
		if err != nil {
			return fmt.Errorf("ssh not found: %w", err)
		}
		// argv[0] must be the program name.
		return syscall.Exec(sshBin, append([]string{"ssh"}, sshArgs...), os.Environ())
	},
}

var sandboxCodeCmd = &cobra.Command{
	Use:   "code <name>",
	Short: "Open a remote sandbox in an editor via SSH",
	Long: `Open a remote sandbox in an editor (e.g. Cursor) using SSH remote access.

Examples:
  amika sandbox code my-sandbox
  amika sandbox code my-sandbox --editor=cursor`,
	Args: cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		cmd.SilenceUsage = true
		cmd.SilenceErrors = true

		name := args[0]
		editor, _ := cmd.Flags().GetString("editor")

		// Currently only cursor is supported.
		if editor != "cursor" {
			return fmt.Errorf("unsupported editor %q; currently only \"cursor\" is supported", editor)
		}

		// Check if this is a local sandbox.
		sandboxesFile, err := config.SandboxesStateFile()
		if err == nil {
			store := sandbox.NewStore(sandboxesFile)
			if _, err := store.Get(name); err == nil {
				return fmt.Errorf("code command currently only works for remote sandboxes; %q is a local sandbox", name)
			}
		}

		// Check that cursor CLI is available.
		if _, err := exec.LookPath("cursor"); err != nil {
			return fmt.Errorf("cursor CLI is not installed or not in PATH; install it from Cursor > Settings > Extensions > cursor-cli")
		}

		target, err := getRemoteTarget(cmd)
		if err != nil {
			return err
		}

		client, err := getRemoteClient(target)
		if err != nil {
			return err
		}

		info, err := client.GetSSH(name)
		if err != nil {
			return err
		}

		if info.SSHDestination == "" {
			return fmt.Errorf("server returned empty SSH destination")
		}

		// Build the ssh-remote+ URI for cursor.
		// SSHDestination may include flags (e.g. "-o StrictHostKeyChecking=no user@host"),
		// but cursor needs just the host/user@host portion as the remote identifier.
		sshDest := info.SSHDestination
		fields := strings.Fields(sshDest)
		// The last field is the user@host (or host) destination.
		remoteHost := fields[len(fields)-1]

		remotePath := "/home/amika/workspace"
		if info.RepoName != "" {
			remotePath = remotePath + "/" + info.RepoName
		}

		cursorCmd := exec.Command("cursor", "--remote", "ssh-remote+"+remoteHost, remotePath)
		cursorCmd.Stdin = os.Stdin
		cursorCmd.Stdout = os.Stdout
		cursorCmd.Stderr = os.Stderr

		fmt.Fprintf(cmd.OutOrStdout(), "Opening sandbox %q in Cursor via SSH (%s)...\n", name, remoteHost)
		fmt.Fprintf(cmd.OutOrStdout(), "Running: cursor --remote ssh-remote+%s %s\n", remoteHost, remotePath)
		fmt.Fprintf(cmd.OutOrStdout(), "Hint: if the file explorer is not visible, press Cmd+Shift+E in Cursor to open it.\n")
		if err := cursorCmd.Run(); err != nil {
			// Provide a helpful hint if the error might be related to the SSH remote extension.
			return fmt.Errorf("cursor failed: %w\n\nMake sure the \"Remote - SSH\" extension is installed in Cursor", err)
		}
		return nil
	},
}

func appendPresetRuntimeEnv(env []string) []string {
	for _, key := range []string{"OPENCODE_SERVER_PASSWORD", "AMIKA_OPENCODE_WEB"} {
		if hasEnvKey(env, key) {
			continue
		}
		if value, ok := os.LookupEnv(key); ok {
			env = append(env, key+"="+value)
		}
	}
	return env
}

func init() {
	rootCmd.AddCommand(sandboxCmd)
	sandboxCmd.AddCommand(sandboxCreateCmd)
	sandboxCmd.AddCommand(sandboxStopCmd)
	sandboxCmd.AddCommand(sandboxDeleteCmd)
	sandboxCmd.AddCommand(sandboxListCmd)
	sandboxCmd.AddCommand(sandboxConnectCmd)
	sandboxCmd.AddCommand(sandboxSSHCmd)
	sandboxCmd.AddCommand(sandboxCodeCmd)

	// Persistent flags for local/remote mode
	sandboxCmd.PersistentFlags().Bool("local", false, "Only operate on local sandboxes")
	sandboxCmd.PersistentFlags().Bool("remote", false, "Only operate on remote sandboxes")
	sandboxCmd.PersistentFlags().String("remote-target", "", "Operate on a specific named remote target")
	sandboxCmd.PersistentFlags().MarkHidden("remote-target")

	// Create flags
	sandboxCreateCmd.Flags().String("provider", "docker", "Sandbox provider")
	sandboxCreateCmd.Flags().String("name", "", "Name for the sandbox (auto-generated if not set)")
	sandboxCreateCmd.Flags().String("image", sandbox.DefaultCoderImage, "Docker image to use")
	sandboxCreateCmd.Flags().String("preset", "", "Use a preset environment (e.g. \"coder\" or \"claude\")")
	sandboxCreateCmd.Flags().StringArray("mount", nil, "Mount a host directory (source:target[:mode], mode defaults to rwcopy)")
	sandboxCreateCmd.Flags().StringArray("volume", nil, "Mount an existing named volume (name:target[:mode], mode defaults to rw)")
	sandboxCreateCmd.Flags().StringArray("port", nil, "Publish a container port (hostPort:containerPort[/protocol], protocol defaults to tcp)")
	sandboxCreateCmd.Flags().String("port-host-ip", "127.0.0.1", "Host IP address to bind published ports")
	sandboxCreateCmd.Flags().String("git", "", "Mount the current git repo root (or repo containing PATH) into /home/amika/workspace/{repo}")
	sandboxCreateCmd.Flags().Lookup("git").NoOptDefVal = "."
	sandboxCreateCmd.Flags().Bool("no-clean", false, "With --git, include untracked files from working tree instead of a clean clone")
	sandboxCreateCmd.Flags().StringArray("env", nil, "Set environment variable (KEY=VALUE)")
	sandboxCreateCmd.Flags().Bool("yes", false, "Skip mount confirmation prompt")
	sandboxCreateCmd.Flags().Bool("connect", false, "Connect to the sandbox shell immediately after creation")
	sandboxCreateCmd.Flags().String("setup-script", "", "Mount a local script file to /usr/local/etc/amikad/setup/setup.sh in the container (read-only)")
	sandboxDeleteCmd.Flags().Bool("force", false, "Skip confirmation prompt")
	sandboxDeleteCmd.Flags().Bool("delete-volumes", false, "Also delete associated volumes that are no longer referenced")
	sandboxDeleteCmd.Flags().Bool("keep-volumes", false, "Keep associated volumes even when only this sandbox references them")
	sandboxConnectCmd.Flags().String("shell", "zsh", "Shell to run in the sandbox container")
	sandboxSSHCmd.Flags().BoolP("t", "t", false, "Force pseudo-terminal allocation (like ssh -t)")
	sandboxSSHCmd.Flags().Bool("revoke", false, "Revoke SSH access for the sandbox")
	sandboxCodeCmd.Flags().String("editor", "cursor", "Editor to open (currently only \"cursor\" is supported)")
}

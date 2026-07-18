package sandboxcmd

// sandbox_create.go implements sandbox creation for local and remote modes.

import (
	"bufio"
	"fmt"
	"os"
	"time"

	"github.com/gofixpoint/amika/go/internal/apiclient"
	"github.com/gofixpoint/amika/go/internal/config"
	"github.com/gofixpoint/amika/go/internal/constants"
	"github.com/gofixpoint/amika/go/internal/output"
	"github.com/gofixpoint/amika/go/internal/runmode"
	"github.com/gofixpoint/amika/go/internal/sandbox"
	"github.com/gofixpoint/amika/go/internal/ssh"
	"github.com/gofixpoint/amika/go/pkg/amika"
	"github.com/spf13/cobra"
)

// sandboxDetailJSON is the JSON emitted by `sandbox create` for the created
// sandbox. It carries structured ports and services (with generated URLs)
// rather than the display strings the text output prints.
type sandboxDetailJSON struct {
	Name        string              `json:"name"`
	Location    string              `json:"location"`
	State       string              `json:"state,omitempty"`
	Provider    string              `json:"provider,omitempty"`
	Image       string              `json:"image,omitempty"`
	ContainerID string              `json:"container_id,omitempty"`
	Branch      string              `json:"branch,omitempty"`
	Ports       []portJSON          `json:"ports"`
	Services    []serviceDetailJSON `json:"services"`
}

// serviceDetailJSON is one named service with its resolved port bindings.
type serviceDetailJSON struct {
	Name  string            `json:"name"`
	Ports []servicePortJSON `json:"ports"`
}

// servicePortJSON is a port binding with an optional generated URL.
type servicePortJSON struct {
	HostIP        string `json:"host_ip,omitempty"`
	HostPort      int    `json:"host_port"`
	ContainerPort int    `json:"container_port"`
	Protocol      string `json:"protocol,omitempty"`
	URL           string `json:"url,omitempty"`
}

// sandboxDetailFromInfo builds the create JSON for a local sandbox.
func sandboxDetailFromInfo(info sandbox.Info) sandboxDetailJSON {
	ports := make([]portJSON, 0, len(info.Ports))
	for _, p := range info.Ports {
		ports = append(ports, portJSON{
			HostIP:        p.HostIP,
			HostPort:      p.HostPort,
			ContainerPort: p.ContainerPort,
			Protocol:      p.Protocol,
		})
	}
	services := make([]serviceDetailJSON, 0, len(info.Services))
	for _, svc := range info.Services {
		sp := make([]servicePortJSON, 0, len(svc.Ports))
		for _, port := range svc.Ports {
			sp = append(sp, servicePortJSON{
				HostIP:        port.HostIP,
				HostPort:      port.HostPort,
				ContainerPort: port.ContainerPort,
				Protocol:      port.Protocol,
				URL:           port.URL,
			})
		}
		services = append(services, serviceDetailJSON{Name: svc.Name, Ports: sp})
	}
	return sandboxDetailJSON{
		Name:        info.Name,
		Location:    "local",
		State:       "running",
		Provider:    info.Provider,
		Image:       info.Image,
		ContainerID: info.ContainerID,
		Branch:      info.Branch,
		Ports:       ports,
		Services:    services,
	}
}

// sandboxDetailFromRemote builds the create JSON for a remote sandbox, grouping
// the flat service list by service name the way the text output does.
func sandboxDetailFromRemote(sb *apiclient.RemoteSandbox) sandboxDetailJSON {
	var order []string
	byName := make(map[string]*serviceDetailJSON, len(sb.Services))
	ports := make([]portJSON, 0, len(sb.Services))
	for _, svc := range sb.Services {
		ports = append(ports, portJSON{
			HostPort:      svc.HostPort,
			ContainerPort: svc.ContainerPort,
			Protocol:      svc.Protocol,
		})
		s, ok := byName[svc.Name]
		if !ok {
			order = append(order, svc.Name)
			byName[svc.Name] = &serviceDetailJSON{Name: svc.Name}
			s = byName[svc.Name]
		}
		s.Ports = append(s.Ports, servicePortJSON{
			HostPort:      svc.HostPort,
			ContainerPort: svc.ContainerPort,
			Protocol:      svc.Protocol,
			URL:           svc.URL,
		})
	}
	services := make([]serviceDetailJSON, 0, len(order))
	for _, name := range order {
		services = append(services, *byName[name])
	}
	return sandboxDetailJSON{
		Name:     sb.Name,
		Location: "remote",
		State:    sb.State,
		Provider: sb.Provider,
		Branch:   sb.Branch,
		Ports:    ports,
		Services: services,
	}
}

var sandboxCreateCmd = &cobra.Command{
	Use:   "create",
	Short: "Create a new sandbox",
	Long:  `Create a new sandbox using the specified provider. Currently only "docker" is supported.`,
	Args:  cobra.NoArgs,
	RunE: func(cmd *cobra.Command, _ []string) error {
		noClean, _ := cmd.Flags().GetBool("no-clean")
		noSetup, _ := cmd.Flags().GetBool("no-setup")
		gitFlag, _ := cmd.Flags().GetString("git")
		gitFlagSet := cmd.Flags().Changed("git")
		noGit, _ := cmd.Flags().GetBool("no-git")
		if noSetup && cmd.Flags().Changed("setup-script") {
			return fmt.Errorf("--no-setup and --setup-script are mutually exclusive")
		}
		mode := runmode.Resolve(cmd)
		if mode != runmode.Remote && cmd.Flags().Changed("github-auth-mode") {
			return fmt.Errorf("--github-auth-mode requires --remote mode")
		}
		if mode != runmode.Remote && cmd.Flags().Changed("snapshot") {
			return fmt.Errorf("--snapshot requires --remote mode")
		}
		// Validate before the remote auth gate below so a bad value fails
		// fast even when the caller is not logged in; otherwise the login
		// error masks the flag error (and the contract test, which runs
		// unauthenticated, would never see the validation).
		githubAuthMode, _ := cmd.Flags().GetString("github-auth-mode")
		if err := sandbox.ValidateGithubAuthMode(githubAuthMode); err != nil {
			return err
		}

		format, err := output.FormatFrom(cmd)
		if err != nil {
			return err
		}
		if connect, _ := cmd.Flags().GetBool("connect"); connect && format.IsJSON() {
			return fmt.Errorf("--connect cannot be combined with --%s %s (it opens an interactive shell)", output.FlagName, format)
		}
		pw := format.Progress(cmd.OutOrStdout())

		cwd, err := os.Getwd()
		if err != nil {
			return fmt.Errorf("failed to determine working directory: %w", err)
		}
		identity, err := resolveRepoIdentity(cwd, gitFlag, gitFlagSet, noGit, noClean)
		if err != nil {
			return err
		}
		fmt.Fprintln(pw, formatRepoBanner(identity))

		target, err := getRemoteTarget(cmd)
		if err != nil {
			return err
		}

		if mode == runmode.Remote && noClean {
			return fmt.Errorf("--no-clean is only supported for local sandboxes")
		}
		if err := runmode.RequireAuth(mode, runmode.DefaultAuthChecker); err != nil {
			return err
		}
		if mode == runmode.Remote {
			return createRemoteSandbox(cmd, target, identity)
		}

		if secretFlags, _ := cmd.Flags().GetStringArray("secret"); len(secretFlags) > 0 {
			return fmt.Errorf("--secret requires --remote mode; secrets are resolved by the remote API")
		}

		provider, _ := cmd.Flags().GetString("provider")
		name, _ := cmd.Flags().GetString("name")
		image, _ := cmd.Flags().GetString("image")
		preset, _ := cmd.Flags().GetString("preset")
		mountStrs, _ := cmd.Flags().GetStringArray("mount")
		volumeStrs, _ := cmd.Flags().GetStringArray("volume")
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

		branchFlag, _ := cmd.Flags().GetString("branch")
		newBranchFlag, _ := cmd.Flags().GetString("new-branch")
		collected, err := collectMounts(mountStrs, volumeStrs, portStrs, portHostIP,
			identity, noClean,
			setupScript, cmd.Flags().Changed("setup-script"),
			noSetup,
			branchFlag, newBranchFlag)
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
			if format.IsJSON() {
				return fmt.Errorf("refusing to prompt for mount confirmation with --%s %s; pass --yes to proceed", output.FlagName, format)
			}
			if gitMountInfo != nil {
				mode := "clean"
				if gitMountInfo.NoClean {
					mode = "no-clean"
				}
				fmt.Fprintln(pw, "Git repo to mount:")
				fmt.Fprintf(pw, "  repo: %s\n", gitMountInfo.RepoName)
				fmt.Fprintf(pw, "  root: %s\n", gitMountInfo.RepoRoot)
				fmt.Fprintf(pw, "  mode: %s\n", mode)
				fmt.Fprintf(pw, "  target: %s\n", gitMountInfo.Mount.Target)
			}
			fmt.Fprintln(pw, "You are about to mount:")
			for _, m := range mounts {
				source := m.Source
				if m.Mode == "rwcopy" && m.SnapshotFrom != "" {
					source = m.SnapshotFrom
				}
				fmt.Fprintf(pw, "  %s -> %s:%s (%s)\n", source, name, m.Target, m.Mode)
			}
			for _, v := range volumeMounts {
				fmt.Fprintf(pw, "  volume %s -> %s:%s (%s)\n", v.Volume, name, v.Target, v.Mode)
			}
			reader := bufio.NewReader(os.Stdin)
			confirmed, err := promptForConfirmation(reader)
			if err != nil {
				return err
			}
			if !confirmed {
				fmt.Fprintln(cmd.OutOrStdout(), "Aborted.")
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

		branch, _ := cmd.Flags().GetString("branch")
		newBranch, _ := cmd.Flags().GetString("new-branch")
		effectiveBranch := branch
		if newBranch != "" {
			effectiveBranch = newBranch
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
			Branch:      effectiveBranch,
		}
		if err := store.Save(info); err != nil {
			return fmt.Errorf("sandbox created but failed to save state: %w", err)
		}
		rb.Disarm()

		fmt.Fprintf(pw, "Sandbox %q created (container %s)\n", name, containerID[:12])
		if len(publishedPorts) > 0 {
			fmt.Fprintln(pw, "Published ports:")
			for _, p := range publishedPorts {
				fmt.Fprintf(pw, "  %s\n", formatPortBinding(p))
			}
		}
		if len(collected.Services) > 0 {
			fmt.Fprintln(pw, "Services:")
			for _, svc := range collected.Services {
				for _, sp := range svc.Ports {
					url := "-"
					if sp.URL != "" {
						url = sp.URL
					}
					fmt.Fprintf(pw, "  %s: %s (url: %s)\n", svc.Name, formatPortBinding(sp.PortBinding), url)
				}
			}
		}

		if format.IsJSON() {
			return format.JSON(cmd.OutOrStdout(), sandboxDetailFromInfo(info))
		}

		if connect {
			if err := runSandboxConnect(name, "zsh", os.Stdin, os.Stdout, os.Stderr); err != nil {
				return fmt.Errorf("sandbox %q created but failed to connect with shell %q: %w", name, "zsh", err)
			}
		}
		return nil
	},
}

func createRemoteSandbox(cmd *cobra.Command, target string, identity repoIdentity) error {
	name, _ := cmd.Flags().GetString("name")
	secretFlags, _ := cmd.Flags().GetStringArray("secret")
	envFlags, _ := cmd.Flags().GetStringArray("env")
	preset, _ := cmd.Flags().GetString("preset")
	if err := sandbox.ValidatePreset(preset); err != nil {
		return err
	}
	size, _ := cmd.Flags().GetString("size")
	if err := sandbox.ValidateSize(size); err != nil {
		return err
	}
	// Validated in RunE before the auth gate; only the value is read here.
	githubAuthMode, _ := cmd.Flags().GetString("github-auth-mode")
	githubAuthMode = sandbox.CanonicalGithubAuthMode(githubAuthMode)
	setupScript, _ := cmd.Flags().GetString("setup-script")
	branch, _ := cmd.Flags().GetString("branch")
	newBranch, _ := cmd.Flags().GetString("new-branch")
	snapshot, _ := cmd.Flags().GetString("snapshot")

	if name == "" {
		name = sandbox.GenerateName()
	}

	var gitURL string
	gitIsLocalPath := identity.Source == repoSourceAutoDetect || identity.Source == repoSourceFlagPath
	switch identity.Source {
	case repoSourceFlagURL:
		gitURL = identity.URL
	case repoSourceAutoDetect, repoSourceFlagPath:
		resolved, err := resolveGitURL(identity.Path)
		if err != nil {
			return err
		}
		gitURL = resolved
	}

	if branch == "" && newBranch == "" && gitIsLocalPath {
		if hostBranch, err := detectHostCurrentBranch(identity.Path); err == nil {
			branch = hostBranch
		}
	}

	// Warn if the auto-detected branch hasn't been pushed to the remote
	// or has local commits that the remote doesn't have yet.
	if branch != "" && newBranch == "" && gitIsLocalPath && !cmd.Flags().Changed("branch") {
		if !isLocalBranchReachableFromRemote(identity.Path, branch) {
			return fmt.Errorf(
				"current branch %q has not been pushed or is not up-to-date with the remote\n\n"+
					"The sandbox will either start from an older version of this branch or\n"+
					"create it fresh from the default branch.\n\n"+
					"Push your branch first, or use --branch to specify your branch explicitly.",
				branch,
			)
		}
	}

	secretEnvVars, err := parseSecretFlags(secretFlags)
	if err != nil {
		return err
	}

	envVars, err := parseEnvVarFlags(envFlags)
	if err != nil {
		return err
	}

	client, err := getRemoteClient(target)
	if err != nil {
		return err
	}

	noSetup, _ := cmd.Flags().GetBool("no-setup")
	if noSetup && cmd.Flags().Changed("setup-script") {
		return fmt.Errorf("--no-setup and --setup-script are mutually exclusive")
	}

	var setupScriptText string
	if noSetup {
		setupScriptText = "#!/bin/bash\nexit 0\n"
	} else if setupScript != "" {
		data, err := os.ReadFile(setupScript)
		if err != nil {
			return fmt.Errorf("reading setup script %q: %w", setupScript, err)
		}
		setupScriptText = string(data)
	}

	credNames, _ := cmd.Flags().GetStringArray("agent-credential")
	credTypes, _ := cmd.Flags().GetStringArray("agent-credential-type")
	credNones, _ := cmd.Flags().GetStringArray("no-agent-credential")
	agentCreds, err := parseAgentCredentialFlags(credNames, credTypes, credNones)
	if err != nil {
		return err
	}

	req := apiclient.CreateSandboxRequest{
		Name: name,
		// Provider is intentionally left unset: the remote API falls back to its
		// configured default provider (SANDBOX_PROVIDER) when none is specified.
		RepoURL:          gitURL,
		EnvVars:          envVars,
		SecretEnvVars:    secretEnvVars,
		Preset:           preset,
		Size:             size,
		SetupScriptText:  setupScriptText,
		AgentCredentials: agentCreds,
		Branch:           branch,
		NewBranchName:    newBranch,
		GithubAuthMode:   githubAuthMode,
	}
	// Only set Snapshot when a slug was given; an unset flag leaves the field
	// nil so the server applies its default snapshot chain.
	if snapshot != "" {
		req.Snapshot = &snapshot
	}

	format, err := output.FormatFrom(cmd)
	if err != nil {
		return err
	}
	pw := format.Progress(cmd.OutOrStdout())

	sb, err := client.CreateSandbox(req)
	if err != nil {
		return err
	}

	resolved := sb.ResolvedAgentCredentials

	fmt.Fprintf(pw, "Sandbox %q initializing...\n", sb.Name)

	sb, err = client.WaitForSandbox(sb.Name)
	if err != nil {
		return err
	}

	fmt.Fprintf(pw, "Sandbox %q created (remote)\n", sb.Name)
	printResolvedAgentCredentials(cmd, resolved)

	if format.IsJSON() {
		return format.JSON(cmd.OutOrStdout(), sandboxDetailFromRemote(sb))
	}

	connect, _ := cmd.Flags().GetBool("connect")
	if connect {
		return ssh.ExecSSH(client, sb.Name, false, nil)
	}

	return nil
}

func printResolvedAgentCredentials(cmd *cobra.Command, resolved []apiclient.ResolvedAgentCredential) {
	if len(resolved) == 0 {
		return
	}
	w := cmd.ErrOrStderr()
	for _, r := range resolved {
		switch r.Outcome {
		case "resolved":
			fmt.Fprintf(w, "Using %s credential %q (%s, source=%s)\n", r.Kind, r.Name, r.Type, r.Source)
		case "skipped":
			fmt.Fprintf(w, "Skipped %s credential (%s)\n", r.Kind, r.Reason)
		}
	}
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

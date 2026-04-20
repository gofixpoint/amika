package sandboxcmd

import (
	"bufio"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/gofixpoint/amika/internal/apiclient"
	"github.com/gofixpoint/amika/internal/config"
	"github.com/gofixpoint/amika/internal/constants"
	"github.com/gofixpoint/amika/internal/runmode"
	"github.com/gofixpoint/amika/internal/sandbox"
	"github.com/gofixpoint/amika/pkg/amika"
	"github.com/spf13/cobra"
)

var sandboxCreateCmd = &cobra.Command{
	Use:   "create",
	Short: "Create a new sandbox",
	Long:  `Create a new sandbox using the specified provider. Currently only "docker" is supported.`,
	Args:  cobra.NoArgs,
	RunE: func(cmd *cobra.Command, _ []string) error {
		cmd.SilenceUsage = true

		noClean, _ := cmd.Flags().GetBool("no-clean")
		noSetup, _ := cmd.Flags().GetBool("no-setup")
		gitFlagChanged := cmd.Flags().Changed("git")
		if err := validateGitFlags(gitFlagChanged, noClean); err != nil {
			return err
		}
		if noSetup && cmd.Flags().Changed("setup-script") {
			return fmt.Errorf("--no-setup and --setup-script are mutually exclusive")
		}

		target, err := getRemoteTarget(cmd)
		if err != nil {
			return err
		}

		mode := runmode.Resolve(cmd)
		if err := runmode.RequireAuth(mode, defaultAuthChecker); err != nil {
			return err
		}
		if mode == runmode.Remote {
			return createRemoteSandbox(cmd, target)
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

		branchFlag, _ := cmd.Flags().GetString("branch")
		newBranchFlag, _ := cmd.Flags().GetString("new-branch")
		collected, err := collectMounts(mountStrs, volumeStrs, portStrs, portHostIP,
			gitPath, gitFlagChanged, noClean,
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

func createRemoteSandbox(cmd *cobra.Command, target string) error {
	name, _ := cmd.Flags().GetString("name")
	gitValue, _ := cmd.Flags().GetString("git")
	secretFlags, _ := cmd.Flags().GetStringArray("secret")
	envFlags, _ := cmd.Flags().GetStringArray("env")
	preset, _ := cmd.Flags().GetString("preset")
	if err := sandbox.ValidatePreset(preset); err != nil {
		return err
	}
	size, _ := cmd.Flags().GetString("size")
	setupScript, _ := cmd.Flags().GetString("setup-script")
	branch, _ := cmd.Flags().GetString("branch")
	newBranch, _ := cmd.Flags().GetString("new-branch")

	if name == "" {
		name = sandbox.GenerateName()
	}

	var gitURL string
	gitValueIsLocalPath := false
	if cmd.Flags().Changed("git") {
		if !strings.HasPrefix(gitValue, "http://") && !strings.HasPrefix(gitValue, "https://") && !strings.HasPrefix(gitValue, "git@") {
			gitValueIsLocalPath = true
		}
		resolved, err := resolveGitURL(gitValue)
		if err != nil {
			return err
		}
		gitURL = resolved
	}

	if branch == "" && newBranch == "" && gitValueIsLocalPath {
		if hostBranch, err := detectHostCurrentBranch(gitValue); err == nil {
			branch = hostBranch
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

	claudeCredentialName := autoSelectClaudeCredential(cmd, client)

	req := apiclient.CreateSandboxRequest{
		Name:                 name,
		Provider:             "daytona",
		GitHubURL:            gitURL,
		EnvVars:              envVars,
		SecretEnvVars:        secretEnvVars,
		Preset:               preset,
		Size:                 size,
		SetupScriptText:      setupScriptText,
		ClaudeCredentialName: claudeCredentialName,
		Branch:               branch,
		NewBranchName:        newBranch,
	}

	sb, err := client.CreateSandbox(req)
	if err != nil {
		return err
	}

	fmt.Fprintf(cmd.OutOrStdout(), "Sandbox %q initializing...\n", sb.Name)

	sb, err = client.WaitForSandbox(sb.Name)
	if err != nil {
		return err
	}

	fmt.Fprintf(cmd.OutOrStdout(), "Sandbox %q created (remote)\n", sb.Name)

	connect, _ := cmd.Flags().GetBool("connect")
	if connect {
		return execSSH(client, sb.Name, false, nil)
	}

	return nil
}

func autoSelectClaudeCredential(cmd *cobra.Command, client *apiclient.Client) string {
	creds, err := client.ListProviderSecrets("claude")
	if err != nil || len(creds) == 0 {
		return ""
	}
	var selected apiclient.ProviderSecretListItem
	for _, c := range creds {
		if c.Type == "oauth" {
			selected = c
			break
		}
	}
	if selected.Name == "" {
		selected = creds[0]
	}
	fmt.Fprintf(cmd.ErrOrStderr(), "Using Claude credential %q (%s)\n", selected.Name, selected.Type)
	return selected.Name
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

package sandboxcmd

// sandbox_create.go implements rig creation against the remote Amika API.

import (
	"fmt"
	"os"

	"github.com/gofixpoint/amika/go/internal/apiclient"
	"github.com/gofixpoint/amika/go/internal/gitrepo"
	"github.com/gofixpoint/amika/go/internal/output"
	"github.com/gofixpoint/amika/go/internal/runmode"
	"github.com/gofixpoint/amika/go/internal/sandbox"
	"github.com/gofixpoint/amika/go/internal/ssh"
	"github.com/spf13/cobra"
)

var sandboxCreateCmd = &cobra.Command{
	Use:   "create",
	Short: "Create a new sandbox",
	Long:  `Create a new sandbox.`,
	Args:  cobra.NoArgs,
	RunE: func(cmd *cobra.Command, _ []string) error {
		noSetup, _ := cmd.Flags().GetBool("no-setup")
		if noSetup && cmd.Flags().Changed("setup-script") {
			return fmt.Errorf("--no-setup and --setup-script are mutually exclusive")
		}
		// Validate before the auth gate below so a bad value fails fast even
		// when the caller is not logged in; otherwise the login error masks the
		// flag error (and the contract test, which runs unauthenticated, would
		// never see the validation).
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
		identity, err := gitrepo.FromCommand(cmd, cwd)
		if err != nil {
			return err
		}
		fmt.Fprintln(pw, formatRepoBanner(identity))

		target, err := getRemoteTarget(cmd)
		if err != nil {
			return err
		}
		if err := runmode.RequireAuth(runmode.DefaultAuthChecker); err != nil {
			return err
		}
		return createRemoteSandbox(cmd, target, identity)
	},
}

func createRemoteSandbox(cmd *cobra.Command, target string, identity gitrepo.Identity) error {
	name, _ := cmd.Flags().GetString("name")
	provider := requestedRemoteProvider(cmd)
	secretFlags, _ := cmd.Flags().GetStringArray("secret")
	envFlags, _ := cmd.Flags().GetStringArray("env")
	preset, _ := cmd.Flags().GetString("preset")
	if err := sandbox.ValidatePreset(preset); err != nil {
		return err
	}
	// Not validated here: the size vocabulary (generations, per-provider
	// availability, preset exclusions) lives in the API, so a client-side list
	// would be a second copy that silently rejects sizes the server accepts.
	// An unknown size comes back as a 400 from the server instead.
	size, _ := cmd.Flags().GetString("size")
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

	gitURL, err := identity.RemoteURL()
	if err != nil {
		return err
	}

	branches, err := gitrepo.ResolveBranch(identity, gitrepo.BranchRequest{
		Branch:    branch,
		NewBranch: newBranch,
	})
	if err != nil {
		return err
	}
	branch, newBranch = branches.Branch, branches.NewBranch

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
		// An unchanged hidden --provider flag produces an empty value, which JSON
		// omits so the API still applies SANDBOX_PROVIDER. Explicit values are
		// forwarded for provider-specific operational and E2E checks.
		Provider:         provider,
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
		// The resolved agent credentials come back on the create (202)
		// response, not the later GET poll, so carry them onto the polled
		// sandbox before encoding. Otherwise -o json would drop the field
		// that text mode prints (printResolvedAgentCredentials above).
		if len(sb.ResolvedAgentCredentials) == 0 {
			sb.ResolvedAgentCredentials = resolved
		}
		return format.JSON(cmd.OutOrStdout(), normalizeSandboxJSON(*sb))
	}

	connect, _ := cmd.Flags().GetBool("connect")
	if connect {
		return ssh.ExecSSH(client, sb.Name, false, nil)
	}

	return nil
}

func requestedRemoteProvider(cmd *cobra.Command) string {
	if !cmd.Flags().Changed("provider") {
		return ""
	}
	provider, _ := cmd.Flags().GetString("provider")
	return provider
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

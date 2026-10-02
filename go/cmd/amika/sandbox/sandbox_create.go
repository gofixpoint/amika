package sandboxcmd

// sandbox_create.go implements rig creation against the remote Amika API.

import (
	"fmt"
	"os"
	"strings"

	"github.com/gofixpoint/amika/go/internal/apiclient"
	"github.com/gofixpoint/amika/go/internal/gitrepo"
	"github.com/gofixpoint/amika/go/internal/output"
	"github.com/gofixpoint/amika/go/internal/runmode"
	"github.com/gofixpoint/amika/go/internal/sandbox"
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
		if _, err := createHostRef(cmd); err != nil {
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

	// RunE already rejected --no-setup together with --setup-script.
	noSetup, _ := cmd.Flags().GetBool("no-setup")

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

	// Last, because it is the only step here that goes to the network: every
	// local parse above should fail without a round trip. RunE already
	// validated the flag itself.
	hostRef, err := createHostRef(cmd)
	if err != nil {
		return err
	}
	hostID, err := resolveCreateHost(client, hostRef)
	if err != nil {
		return err
	}

	req := apiclient.CreateSandboxRequest{
		Name: name,
		// An unchanged hidden --provider flag produces an empty value, which JSON
		// omits so the API still applies SANDBOX_PROVIDER. Explicit values are
		// forwarded for provider-specific operational and E2E checks.
		Provider:         provider,
		HostID:           hostID,
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
	if err := assertRigLandedOnHost(sb, hostID); err != nil {
		return err
	}

	fmt.Fprintf(pw, "Sandbox %q created\n", sb.Name)
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
		return connectSandbox(client, sb)
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

// createHostRef reads --host and checks everything about it that needs no
// network: whether it was given at all, that it is not blank, and the flags it
// cannot be combined with. Returns "" when the flag was absent, which is what
// runs the rig on Amika Cloud.
//
// An absent flag and an empty value are deliberately not the same thing. A
// script that passes --host "$AMIKA_HOST" with the variable unset means to
// name a host, and silently landing that rig on Amika Cloud — different
// compute, separately billed — is the one outcome it must not get.
func createHostRef(cmd *cobra.Command) (string, error) {
	if !cmd.Flags().Changed("host") {
		return "", nil
	}
	raw, _ := cmd.Flags().GetString("host")
	ref := strings.TrimSpace(raw)
	if ref == "" {
		return "", fmt.Errorf("--host needs a hostname or id; omit it to run the rig on Amika Cloud")
	}
	// Caught here rather than as a 400 from the API, which refuses both
	// alongside host_id.
	//
	// Keyed on the value, not on Changed, unlike --host above: these reject a
	// request the server would refuse, and an empty --snapshot or --provider
	// is already dropped from the body further down, so the same invocation
	// without --host succeeds. --host itself is the other way round because
	// an empty value there is a failed substitution, not an absent request.
	//
	// Untrimmed, deliberately: the send path tests these the same way, so a
	// whitespace-only value does reach the body and must be caught here
	// rather than coming back as a 400.
	for _, conflict := range []struct{ flag, why string }{
		{"snapshot", "a rig on your own host boots its preset's base image, so it has nowhere to fork a cloud snapshot from"},
		{"provider", "a rig on your own host runs on that host's daemon, not on a cloud provider"},
	} {
		if value, _ := cmd.Flags().GetString(conflict.flag); value != "" {
			return "", fmt.Errorf("--%s cannot be combined with --host: %s", conflict.flag, conflict.why)
		}
	}
	return ref, nil
}

// resolveCreateHost turns a --host value into the host id the API takes, or
// "" for the absent flag that createHostRef reports as "". An empty id is
// what puts the rig on Amika Cloud: --host names one of the organization's
// *own* hosts and nothing else, so there is no spelling of it that selects
// the cloud.
func resolveCreateHost(client *apiclient.Client, ref string) (string, error) {
	if ref == "" {
		return "", nil
	}
	// Listed and matched in two steps rather than through FindHost: only a
	// ref that matched nothing earns the hint below. A listing that failed on
	// auth, the network, or a bad response has to surface as itself.
	hosts, err := client.ListHosts()
	if err != nil {
		return "", err
	}
	host, err := apiclient.MatchHost(hosts, ref)
	if err != nil {
		// "cloud" and "amika" are legal hostnames, so the hint waits until the
		// org has no host by that name in any casing. Hostnames are stored
		// lowercase, so `--host Cloud` against a host named `cloud` is a typo
		// to report as one, not an invitation to drop the flag.
		//
		// The hint is appended to MatchHost's error rather than replacing it:
		// an org whose only host is named `amika-cloud` and a user who typed
		// `--host amika` need to see that hostname, or they take the advice
		// and land on the cloud compute they were trying to avoid.
		if isAmikaCloudRef(ref) && !hasHostNamed(hosts, ref) {
			return "", fmt.Errorf("%w (rigs run on Amika Cloud by default: omit --host rather than naming it)", err)
		}
		return "", err
	}
	// The API stores a URL only after validating it, so in practice this is
	// the nil case; the empty check is belt and braces against a host row
	// that somehow carries one.
	if host.URL == nil || *host.URL == "" {
		return "", fmt.Errorf("host %q is registered but has no URL yet; run `amika-hostd register-url <url>` on it", host.Hostname)
	}
	return host.ID, nil
}

// assertRigLandedOnHost checks that a rig asked for by --host actually got
// that host. The create request is validated by a plain zod object, which
// *strips* fields it does not know rather than rejecting them, so a control
// plane predating `host_id` — or any self-hosted one without it — answers
// `GET /hosts` happily, drops the field, and builds the rig on Amika Cloud.
// Reporting success there is the one outcome --host exists to prevent, and
// the polled resource already carries the answer.
func assertRigLandedOnHost(sb *apiclient.RemoteSandbox, hostID string) error {
	if hostID == "" || (sb.HostID != nil && *sb.HostID == hostID) {
		return nil
	}
	// Only the dropped-field case points at an old control plane; one that
	// reports some other host id plainly understands host_id, so saying so
	// there would contradict the sentence before it.
	diagnosis := "It is most likely a version that does not support --host, which silently ignores it."
	if sb.HostID != nil && *sb.HostID != "" {
		diagnosis = "That is not the host this command resolved, so the two disagree about which host was asked for."
	}
	return fmt.Errorf(
		"rig %q was created, but not on the host you asked for: the control plane reports it on %s. %s "+
			"Delete the rig with `amika rig delete %s`",
		sb.Name, rigLanding(sb), diagnosis, sb.Name)
}

// rigLanding names where a rig actually ended up, for the mismatch above.
func rigLanding(sb *apiclient.RemoteSandbox) string {
	if sb.HostID != nil && *sb.HostID != "" {
		return fmt.Sprintf("host %s", *sb.HostID)
	}
	if sb.Provider != nil && *sb.Provider != "" {
		return fmt.Sprintf("Amika Cloud (provider %s)", *sb.Provider)
	}
	return "Amika Cloud"
}

// hasHostNamed reports whether any host's hostname matches ref ignoring case.
func hasHostNamed(hosts []apiclient.Host, ref string) bool {
	for _, h := range hosts {
		if strings.EqualFold(h.Hostname, ref) {
			return true
		}
	}
	return false
}

// isAmikaCloudRef reports whether ref is someone asking for the default by
// name. They get a sentence telling them to drop the flag instead of "no host
// named amika-cloud", which reads like the host is missing.
func isAmikaCloudRef(ref string) bool {
	switch strings.ToLower(ref) {
	case "amika", "amika-cloud", "amika cloud", "amikacloud", "cloud":
		return true
	}
	return false
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

package sandboxcmd

// sandbox_remote.go provides the shared remote-target and client helpers used
// by the rig commands, plus the one output convention applied on top of the
// API mirror before encoding (see AGENTS.md, "CLI Output Format (--output)").

import (
	"fmt"

	"github.com/gofixpoint/amika/go/internal/apiclient"
	"github.com/gofixpoint/amika/go/internal/runmode"
	"github.com/spf13/cobra"
)

// TODO: Parse env variables from an environment file (e.g. .amika/.env or ~/.config/amika/env)
// so users don't need to export AMIKA_API_URL, AMIKA_WORKOS_CLIENT_ID, etc. in their shell profile.

// getRemoteTarget validates the --remote-target flag and returns the target string.
// The flag is currently hidden and disabled; it will be enabled once named-remote config is implemented.
func getRemoteTarget(cmd *cobra.Command) (string, error) {
	target, _ := cmd.Flags().GetString("remote-target")
	if target != "" {
		return "", fmt.Errorf("--remote-target is not yet supported")
	}
	return target, nil
}

// getRemoteClient returns an API client for the given remote target. The client
// construction is shared via runmode.NewRemoteClient; target is threaded through
// (currently a no-op) so named-remote support can resolve a per-target endpoint
// here without touching call sites.
func getRemoteClient(target string) (*apiclient.Client, error) {
	_ = target
	return runmode.NewRemoteClient(), nil
}

// getEditorClient pins one credential for target resolution and GC ownership
// recording. A concurrent login must not attribute a verified host to a
// different account between those two operations.
func getEditorClient(target string) (*apiclient.Client, error) {
	client, err := getRemoteClient(target)
	if err != nil {
		return nil, err
	}
	token, err := client.TokenSource.Token()
	if err != nil {
		return nil, err
	}
	client.TokenSource = apiclient.NewStaticTokenSource(token)
	return client, nil
}

// deref returns the empty string for a nil pointer, or the pointed-to value.
func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

// normalizeSandboxJSON applies one CLI-side output convention on top of the
// API mirror before encoding: `services` is always emitted as `[]` rather
// than `null`, even though the schema marks the field nullable, since an
// empty array is easier for scripts to consume uniformly than having to
// handle both `[]` and `null`.
func normalizeSandboxJSON(sb apiclient.RemoteSandbox) apiclient.RemoteSandbox {
	if sb.Services == nil {
		sb.Services = []apiclient.RemoteSandboxService{}
	}
	return sb
}

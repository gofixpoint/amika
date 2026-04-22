package sandboxcmd

// sandbox_local_remote.go provides shared auth and remote client helpers.

import (
	"fmt"
	"os"

	"github.com/gofixpoint/amika/internal/apiclient"
	"github.com/gofixpoint/amika/internal/auth"
	"github.com/gofixpoint/amika/internal/config"
	"github.com/spf13/cobra"
)

// TODO: Parse env variables from an environment file (e.g. .amika/.env or ~/.config/amika/env)
// so users don't need to export AMIKA_API_URL, AMIKA_WORKOS_CLIENT_ID, etc. in their shell profile.

// defaultAuthChecker returns nil when any credential source is present:
// AMIKA_API_KEY env var, a stored API key, or a valid WorkOS session.
// An unreadable API key file is skipped (matching the request-time
// resolver) so a corrupt higher-priority file does not block a valid
// lower-priority session.
func defaultAuthChecker() error {
	if os.Getenv(config.EnvAPIKey) != "" {
		return nil
	}
	if stored, err := auth.LoadAPIKey(); err == nil && stored != nil {
		return nil
	}
	_, err := auth.GetValidSession(config.WorkOSClientID())
	return err
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
// Credentials are resolved per request in the order: AMIKA_API_KEY env var,
// stored API key file, then WorkOS session.
func getRemoteClient(target string) (*apiclient.Client, error) {
	_ = target
	return apiclient.NewClientWithTokenSource(config.APIURL(), apiclient.NewResolvedTokenSource(config.WorkOSClientID())), nil
}

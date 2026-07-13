package sandboxcmd

// sandbox_local_remote.go provides the shared remote-target helper.

import (
	"fmt"

	"github.com/spf13/cobra"
)

// TODO: Parse env variables from an environment file (e.g. .amika/.env or ~/.config/amika/env)
// so users don't need to export AMIKA_API_URL, AMIKA_WORKOS_CLIENT_ID, etc. in their shell profile.

// getRemoteTarget validates that --remote-target is not combined with --local or --remote, and returns the target string.
// The flag is currently hidden and disabled; it will be enabled once named-remote config is implemented.
func getRemoteTarget(cmd *cobra.Command) (string, error) {
	target, _ := cmd.Flags().GetString("remote-target")
	if target != "" {
		return "", fmt.Errorf("--remote-target is not yet supported")
	}
	return target, nil
}

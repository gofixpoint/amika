// Package runmode resolves whether a CLI command should operate against local
// or remote sandboxes and guards remote operations behind authentication.
package runmode

import (
	"fmt"
	"os"

	"github.com/spf13/cobra"
)

// Mode represents whether a command operates on local or remote sandboxes.
type Mode int

const (
	// Local restricts the command to locally-managed sandboxes.
	Local Mode = iota
	// Remote directs the command to the remote API.
	Remote
)

// String returns the human-readable name of the mode.
func (m Mode) String() string {
	switch m {
	case Local:
		return "local"
	case Remote:
		return "remote"
	default:
		return "unknown"
	}
}

// Resolve reads the --local flag from cmd and returns the resolved Mode.
// The default is Remote; only an explicit --local flag switches to Local.
func Resolve(cmd *cobra.Command) Mode {
	local, _ := cmd.Flags().GetBool("local")
	if local {
		return Local
	}
	return Remote
}

// AuthChecker is a function that returns nil when the caller has valid
// credentials, or an error describing why authentication failed.
type AuthChecker func() error

// RequireAuth verifies that the caller is authenticated when mode is Remote.
// It returns nil immediately for Local mode. For Remote mode it first checks
// the AMIKA_API_KEY environment variable (which bypasses session auth), then
// falls back to the provided AuthChecker.
func RequireAuth(mode Mode, check AuthChecker) error {
	if mode == Local {
		return nil
	}
	if os.Getenv("AMIKA_API_KEY") != "" {
		return nil
	}
	if err := check(); err != nil {
		return fmt.Errorf("not logged in; run \"amika auth login\" or use --local")
	}
	return nil
}

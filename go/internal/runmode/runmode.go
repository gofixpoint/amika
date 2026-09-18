// Package runmode guards remote operations behind authentication.
//
// Every CLI command operates against the remote Amika API; the local-sandbox
// mode (the former --local flag) has been removed.
package runmode

import (
	"fmt"
	"os"

	"github.com/gofixpoint/amika/go/internal/apiclient"
	"github.com/gofixpoint/amika/go/internal/auth"
	"github.com/gofixpoint/amika/go/internal/config"
)

// AuthChecker is a function that returns nil when the caller has valid
// credentials, or an error describing why authentication failed.
type AuthChecker func() error

// RequireAuth verifies that the caller is authenticated. It first checks the
// AMIKA_API_KEY environment variable (which bypasses session auth), then falls
// back to the provided AuthChecker.
func RequireAuth(check AuthChecker) error {
	if os.Getenv("AMIKA_API_KEY") != "" {
		return nil
	}
	if err := check(); err != nil {
		return fmt.Errorf("not logged in; run \"amika auth login\"")
	}
	return nil
}

// DefaultAuthChecker is the AuthChecker most commands pass to RequireAuth. It
// returns nil when any credential source is present: the AMIKA_API_KEY env var,
// a stored API key file, or a valid WorkOS session. An unreadable API key file
// is skipped (matching the request-time resolver) so a corrupt higher-priority
// file does not block a valid lower-priority session. RequireAuth also checks
// the env var, but this stays a complete standalone credential check.
func DefaultAuthChecker() error {
	if os.Getenv(config.EnvAPIKey) != "" {
		return nil
	}
	if stored, err := auth.LoadAPIKey(); err == nil && stored != nil {
		return nil
	}
	_, err := auth.GetValidSession(config.WorkOSClientID())
	return err
}

// NewRemoteClient returns an API client for the remote Amika API, authenticated
// with the current session. Credentials are resolved per request in the order:
// AMIKA_API_KEY env var, stored API key file, then WorkOS session.
func NewRemoteClient() *apiclient.Client {
	return apiclient.NewClientWithTokenSource(config.APIURL(), apiclient.NewResolvedTokenSource(config.WorkOSClientID()))
}

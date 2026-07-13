package main

import (
	"os"

	"github.com/gofixpoint/amika/go/internal/apiclient"
	"github.com/gofixpoint/amika/go/internal/auth"
	"github.com/gofixpoint/amika/go/internal/config"
)

// newRemoteClient returns an API client authenticated with the current session.
// Credentials are resolved per request in the order: AMIKA_API_KEY env var,
// stored API key file, then WorkOS session.
func newRemoteClient() *apiclient.Client {
	return apiclient.NewClientWithTokenSource(config.APIURL(), apiclient.NewResolvedTokenSource(config.WorkOSClientID()))
}

// remoteAuthChecker returns nil when any credential source is present:
// AMIKA_API_KEY env var, a stored API key, or a valid WorkOS session. An
// unreadable API key file is skipped so a corrupt higher-priority file does not
// block a valid lower-priority session. Mirrors the sandbox command's checker
// so top-level remote commands surface the same "not logged in" guidance.
func remoteAuthChecker() error {
	if os.Getenv(config.EnvAPIKey) != "" {
		return nil
	}
	if stored, err := auth.LoadAPIKey(); err == nil && stored != nil {
		return nil
	}
	_, err := auth.GetValidSession(config.WorkOSClientID())
	return err
}

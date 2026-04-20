package main

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

// defaultAuthChecker returns nil when a valid WorkOS session exists.
func defaultAuthChecker() error {
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
// If AMIKA_API_KEY is set, it is used as a static bearer token instead of the WorkOS session.
func getRemoteClient(target string) (*apiclient.Client, error) {
	_ = target
	if apiKey := os.Getenv("AMIKA_API_KEY"); apiKey != "" {
		return apiclient.NewClient(config.APIURL(), apiKey), nil
	}
	return apiclient.NewClientWithTokenSource(config.APIURL(), apiclient.NewWorkOSTokenSource(config.WorkOSClientID())), nil
}

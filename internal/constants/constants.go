// Package constants defines shared constant values used across the amika codebase.
package constants

const (
	// EnvSandboxProvider is the environment variable name that identifies the
	// sandbox provider inside a running container.
	EnvSandboxProvider = "AMIKA_SANDBOX_PROVIDER"

	// ProviderLocalDocker is the provider value for local Docker sandboxes.
	ProviderLocalDocker = "local-docker"
)

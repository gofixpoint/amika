// Package constants defines shared constant values used across the amika codebase.
package constants

const (
	// EnvSandboxProvider is the environment variable name that identifies the
	// sandbox provider inside a running container.
	EnvSandboxProvider = "AMIKA_SANDBOX_PROVIDER"

	// ProviderLocalDocker is the provider value for local Docker sandboxes.
	ProviderLocalDocker = "local-docker"

	// ReservedPortStart is the beginning of the port range reserved for Amika
	// internal services inside sandbox containers (inclusive).
	ReservedPortStart = 60899

	// ReservedPortEnd is the end of the port range reserved for Amika
	// internal services inside sandbox containers (inclusive).
	ReservedPortEnd = 60999

	// OpenCodeWebPort is the container port reserved for the OpenCode web UI.
	OpenCodeWebPort = 60998

	// ManagedSSHDPort is the loopback port amikad's managed sshd binds.
	//
	// Deliberately not 22: base images may ship a socket-activated system
	// `ssh.socket` bound to the wildcard `*:22`, which also covers
	// `127.0.0.1:22` and makes the managed sshd fail with EADDRINUSE. Living
	// in the Amika reserved range keeps it clear of both the system sshd and
	// the random port allocator, which skips the whole range.
	ManagedSSHDPort = 60997
)

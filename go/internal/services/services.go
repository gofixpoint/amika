// Package services holds shared logic for sandbox services that must stay
// consistent across the CLI and the HTTP API, such as port validation rules.
package services

import "fmt"

const (
	// ReservedPortMin is the inclusive lower bound of the container port range
	// Amika reserves for its own internal sandbox services.
	ReservedPortMin = 60899
	// ReservedPortMax is the inclusive upper bound of the reserved range (e.g.
	// the OpenCode web UI on 60998 and the amikad daemon on 60999). User
	// services may not bind ports in this range. See
	// docs/sandbox-configuration.md for the full allocation table.
	ReservedPortMax = 60999
)

// ValidatePort reports whether port is a legal, user-assignable container port
// for a sandbox service: within 1–65535 and outside the reserved Amika range
// (ReservedPortMin–ReservedPortMax). It returns a descriptive error otherwise.
func ValidatePort(port int) error {
	if port < 1 || port > 65535 {
		return fmt.Errorf("invalid port %d: must be between 1 and 65535", port)
	}
	if port >= ReservedPortMin && port <= ReservedPortMax {
		return fmt.Errorf("invalid port %d: ports %d-%d are reserved for internal Amika services", port, ReservedPortMin, ReservedPortMax)
	}
	return nil
}

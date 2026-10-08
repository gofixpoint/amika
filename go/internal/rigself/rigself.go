// Package rigself resolves the "_self" rig reference.
//
// Code running inside a rig often needs to name that same rig, e.g.
// `amika service list --rig-name "$AMIKA_RIG_NAME"`. Any CLI field that names
// a rig instead accepts the literal "_self", which this package swaps for the
// current rig's name, read from the environment every rig session carries.
// AMIKA_RIG_NAME wins over the legacy AMIKA_SANDBOX_NAME; an empty variable
// counts as unset.
//
// Call sites resolve a reference once, as soon as they read it from argv or a
// flag, so everything downstream (API calls, prompts, output) sees the real
// name.
package rigself

import (
	"errors"
	"fmt"
	"os"

	"github.com/spf13/cobra"
)

const (
	// Ref is the literal rig reference that names the current rig.
	Ref = "_self"
	// RigNameEnv is the preferred environment variable carrying the current
	// rig's name.
	RigNameEnv = "AMIKA_RIG_NAME"
	// SandboxNameEnv is the legacy environment variable carrying the current
	// rig's name, consulted when RigNameEnv is unset or empty.
	SandboxNameEnv = "AMIKA_SANDBOX_NAME"
)

// ErrNotInRig reports a "_self" reference made where neither environment
// variable names a rig.
var ErrNotInRig = errors.New("not running inside a rig")

// Resolver resolves "_self" references against an environment.
type Resolver struct {
	// LookupEnv reads one environment variable, with os.LookupEnv semantics.
	LookupEnv func(key string) (string, bool)
}

// Default resolves against the process environment.
var Default = Resolver{LookupEnv: os.LookupEnv}

// Name returns the current rig's name, preferring RigNameEnv over
// SandboxNameEnv. It returns ErrNotInRig when neither is set to a non-empty
// value.
func (r Resolver) Name() (string, error) {
	for _, key := range []string{RigNameEnv, SandboxNameEnv} {
		if value, ok := r.LookupEnv(key); ok && value != "" {
			return value, nil
		}
	}
	return "", fmt.Errorf("%q names the current rig, but neither %s nor %s is set: %w", Ref, RigNameEnv, SandboxNameEnv, ErrNotInRig)
}

// Resolve returns the current rig's name when ref is Ref, and ref unchanged
// otherwise.
func (r Resolver) Resolve(ref string) (string, error) {
	if ref != Ref {
		return ref, nil
	}
	return r.Name()
}

// ResolveAll resolves every ref in refs, returning a new slice.
func (r Resolver) ResolveAll(refs []string) ([]string, error) {
	resolved := make([]string, len(refs))
	for i, ref := range refs {
		name, err := r.Resolve(ref)
		if err != nil {
			return nil, err
		}
		resolved[i] = name
	}
	return resolved, nil
}

// Flag reads the string flag name from cmd and resolves it.
func (r Resolver) Flag(cmd *cobra.Command, name string) (string, error) {
	ref, err := cmd.Flags().GetString(name)
	if err != nil {
		return "", err
	}
	return r.Resolve(ref)
}

// Name returns the current rig's name from the process environment.
func Name() (string, error) { return Default.Name() }

// Resolve resolves ref against the process environment.
func Resolve(ref string) (string, error) { return Default.Resolve(ref) }

// ResolveAll resolves refs against the process environment.
func ResolveAll(refs []string) ([]string, error) { return Default.ResolveAll(refs) }

// Flag reads the string flag name from cmd and resolves it against the process
// environment.
func Flag(cmd *cobra.Command, name string) (string, error) { return Default.Flag(cmd, name) }

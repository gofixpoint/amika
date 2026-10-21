// Package rigref parses the rig references the CLI accepts wherever a user
// names a rig.
//
// A reference says which field it matches by an optional `kind=` prefix:
//
//	my-rig          matches by id or by name; ambiguous if both match
//	ref=my-rig      the same, spelled out
//	name=my-rig     matches by name only
//	id=9f3c8b21-…   matches by id only
//
// The kinds mirror the control plane's resource-ref convention (amika-mono's
// devdocs/api-resource-refs.md), so a parsed Ref maps directly onto the API's
// `by`/`sandbox_by` selectors and `sandbox_ref`/`sandbox_name`/`sandbox_id`
// fields, and every command sends its reference, kind included, in a single
// request for the server to resolve.
//
// The prefix cannot collide with a current rig: ids are UUIDs (or, for old
// rigs, `sbox-<uuid>`) and new names are single DNS labels, none of which
// contains '='. Only the value before the first '=' is inspected, and only the
// three kind words count as a prefix, so a legacy name that happens to start
// with one is still reachable as `name=id=…` or `ref=id=…`. '=' rather than ':'
// because `amika scp` already splits `<rig>:<path>` on the first colon.
//
// # The current rig
//
// Code running inside a rig often needs to name that same rig, e.g.
// `amika service list --rig "$AMIKA_RIG_NAME"`. Any reference may instead be
// the literal "_self" (Self), which Parse swaps for the current rig's name,
// read from the environment every rig session carries: AMIKA_RIG_NAME
// (RigNameEnv) wins over the legacy AMIKA_SANDBOX_NAME (SandboxNameEnv), and an
// empty variable counts as unset. "_self" and "ref=_self" stand in for typing
// that name bare, so they go to the API as a plain ref; "name=_self" pins the
// match to the name; "id=_self" is refused, since "_self" is a name.
//
// Call sites parse a reference as soon as they read it from argv or a flag,
// before the auth check, so a malformed reference or a "_self" outside a rig
// is reported as itself rather than as a login prompt, and everything
// downstream (API calls, prompts, output) sees the real name.
package rigref

import (
	"errors"
	"fmt"
	"os"
	"strings"

	"github.com/gofixpoint/amika/go/internal/apiclient"
)

const (
	// Self is the literal rig reference that names the current rig.
	Self = "_self"
	// RigNameEnv is the preferred environment variable carrying the current
	// rig's name.
	RigNameEnv = "AMIKA_RIG_NAME"
	// SandboxNameEnv is the legacy environment variable carrying the current
	// rig's name, consulted when RigNameEnv is unset or empty.
	SandboxNameEnv = "AMIKA_SANDBOX_NAME"
)

// ErrNotInRig reports a "_self" reference made where neither RigNameEnv nor
// SandboxNameEnv names a rig.
var ErrNotInRig = errors.New("not running inside a rig")

// Resolver finds the current rig's name, which "_self" stands for, in an
// environment.
type Resolver struct {
	// LookupEnv reads one environment variable, with os.LookupEnv semantics.
	LookupEnv func(key string) (string, bool)
}

// Default resolves the current rig against the process environment. Parse
// uses it.
var Default = Resolver{LookupEnv: os.LookupEnv}

// Name returns the current rig's name, preferring RigNameEnv over
// SandboxNameEnv. It returns an error wrapping ErrNotInRig, and naming both
// variables, when neither is set to a non-empty value.
func (r Resolver) Name() (string, error) {
	for _, key := range []string{RigNameEnv, SandboxNameEnv} {
		if value, ok := r.LookupEnv(key); ok && value != "" {
			return value, nil
		}
	}
	return "", fmt.Errorf("%q names the current rig, but neither %s nor %s is set: %w", Self, RigNameEnv, SandboxNameEnv, ErrNotInRig)
}

// Kind says which field of a rig a reference matches.
type Kind string

const (
	// KindRef matches a rig by id or by name, refusing a value that names one
	// rig by id and a different rig by name.
	KindRef Kind = "ref"
	// KindName matches a rig by name only.
	KindName Kind = "name"
	// KindID matches a rig by id only.
	KindID Kind = "id"
)

// Ref is a parsed rig reference.
type Ref struct {
	Kind  Kind
	Value string
	// self marks a "_self" not spelled name=_self: Value holds the current
	// rig's name, but the reference goes to the API as a plain ref, the way
	// the user would have sent that name typed bare.
	self bool
}

// Selector returns the API selector for r: the reference's value with its kind
// as the API's `by`/`sandbox_by` value. A "_self" without name= selects by ref
// (see the package comment). The zero Ref yields the zero selector, which
// list filters read as no filter.
func (r Ref) Selector() apiclient.SandboxSelector {
	if r.self {
		return apiclient.SandboxByRef(r.Value)
	}
	return apiclient.SandboxSelector{Value: r.Value, By: string(r.Kind)}
}

// ErrAmbiguous reports a KindRef value that is one rig's id and another rig's
// name.
var ErrAmbiguous = errors.New("ambiguous rig reference")

// ambiguous builds the ErrAmbiguous error for value, naming the two prefixed
// spellings that would pick one rig.
func ambiguous(value string) error {
	return fmt.Errorf("%w: %q is one rig's id and another rig's name; use %q or %q",
		ErrAmbiguous, value, string(KindID)+"="+value, string(KindName)+"="+value)
}

// Explain rewrites the API's 409 resource_ref_ambiguous for a request that
// named a rig by r into ErrAmbiguous, which tells the user how to pick one of
// the two rigs. Any other error, including nil, is returned unchanged.
func Explain(r Ref, err error) error {
	// Only a ref can be ambiguous; a pinned kind that somehow draws the 409
	// keeps the server's message rather than suggesting the prefix it already
	// has.
	if err != nil && r.Kind == KindRef && !r.self && apiclient.IsResourceRefAmbiguous(err) {
		return ambiguous(r.Value)
	}
	return err
}

// Prefix returns the kind raw's `kind=` prefix spells out, and false when raw
// has none (a bare value, or "_self").
func Prefix(raw string) (Kind, bool) {
	prefix, _, ok := strings.Cut(raw, "=")
	if !ok {
		return "", false
	}
	switch Kind(prefix) {
	case KindRef, KindName, KindID:
		return Kind(prefix), true
	}
	return "", false
}

// Parse parses raw into a Ref, resolving "_self" through Default. An empty
// value, with or without a prefix, is an error.
func Parse(raw string) (Ref, error) { return parseWith(Default, raw) }

// parseWith parses raw into a Ref, resolving "_self" through resolver.
func parseWith(resolver Resolver, raw string) (Ref, error) {
	ref := Ref{Kind: KindRef, Value: raw}
	if kind, ok := Prefix(raw); ok {
		ref = Ref{Kind: kind, Value: raw[len(kind)+1:]}
	}
	if strings.TrimSpace(ref.Value) == "" {
		if _, prefixed := Prefix(raw); prefixed {
			return Ref{}, fmt.Errorf("rig reference %q has no value after %q", raw, string(ref.Kind)+"=")
		}
		return Ref{}, fmt.Errorf("rig reference must not be empty")
	}
	if ref.Value != Self {
		return ref, nil
	}
	if ref.Kind == KindID {
		return Ref{}, fmt.Errorf("%q stands for the current rig's name, not its id; use %q or %q", Self, Self, "name="+Self)
	}
	name, err := resolver.Name()
	if err != nil {
		return Ref{}, err
	}
	return Ref{Kind: KindName, Value: name, self: ref.Kind == KindRef}, nil
}

// Find returns the index of the rig in rigs that r names, or -1 when none
// does. id and name read those fields off a rig. A KindRef value matching one
// rig's id and a different rig's name returns ErrAmbiguous.
func Find[T any](r Ref, rigs []T, id, name func(T) string) (int, error) {
	byID, byName := -1, -1
	for i, rig := range rigs {
		if byID < 0 && r.Kind != KindName && id(rig) == r.Value {
			byID = i
		}
		if byName < 0 && r.Kind != KindID && name(rig) == r.Value {
			byName = i
		}
	}
	switch {
	case byID >= 0 && byName >= 0 && byID != byName:
		return -1, ambiguous(r.Value)
	case byID >= 0:
		return byID, nil
	default:
		return byName, nil
	}
}

// Label is how output names the rig raw refers to while its canonical name is
// unknown: raw as the user wrote it, except that a "_self" value shows the
// rig name it stands for. r is raw, parsed.
func Label(raw string, r Ref) string {
	value := raw
	if kind, ok := Prefix(raw); ok {
		value = raw[len(kind)+1:]
	}
	if value == Self {
		return r.Value
	}
	return raw
}

// ParseAll parses every reference in raws with Parse, stopping at the first
// error.
func ParseAll(raws []string) ([]Ref, error) {
	refs := make([]Ref, len(raws))
	for i, raw := range raws {
		ref, err := Parse(raw)
		if err != nil {
			return nil, err
		}
		refs[i] = ref
	}
	return refs, nil
}

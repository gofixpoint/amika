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
// `by`/`sandbox_by` selectors.
//
// The prefix cannot collide with a current rig: ids are UUIDs and new names are
// single DNS labels, neither of which contains '='. Only the value before the
// first '=' is inspected, and only the three kind words count as a prefix, so a
// legacy name that happens to start with one is still reachable as
// `name=id=…` or `ref=id=…`. '=' rather than ':' because `amika scp` already
// splits `<rig>:<path>` on the first colon.
//
// "_self" (see rigself) is resolved here too, to a name match, since it stands
// for the current rig's name.
package rigref

import (
	"errors"
	"fmt"
	"strings"

	"github.com/gofixpoint/amika/go/internal/rigself"
)

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
}

// String renders the reference the way a user would write it, with the prefix
// omitted for KindRef.
func (r Ref) String() string {
	if r.Kind == KindRef {
		return r.Value
	}
	return string(r.Kind) + "=" + r.Value
}

// ErrAmbiguous reports a KindRef value that is one rig's id and another rig's
// name.
var ErrAmbiguous = errors.New("ambiguous rig reference")

// Parse parses raw into a Ref, resolving "_self" through rigself.Default.
func Parse(raw string) (Ref, error) { return ParseWith(rigself.Default, raw) }

// ParseWith parses raw into a Ref, resolving "_self" through resolver.
func ParseWith(resolver rigself.Resolver, raw string) (Ref, error) {
	ref := Ref{Kind: KindRef, Value: raw}
	if prefix, value, ok := strings.Cut(raw, "="); ok {
		switch Kind(prefix) {
		case KindRef, KindName, KindID:
			ref = Ref{Kind: Kind(prefix), Value: value}
		}
	}
	if ref.Kind != KindRef && ref.Value == "" {
		return Ref{}, fmt.Errorf("rig reference %q has no value after %q", raw, string(ref.Kind)+"=")
	}
	if ref.Value != rigself.Ref {
		return ref, nil
	}
	if ref.Kind == KindID {
		return Ref{}, fmt.Errorf("%q stands for the current rig's name, not its id; use %q or %q", rigself.Ref, rigself.Ref, "name="+rigself.Ref)
	}
	name, err := resolver.Name()
	if err != nil {
		return Ref{}, err
	}
	return Ref{Kind: KindName, Value: name}, nil
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
		return -1, fmt.Errorf("%w: %q is one rig's id and another rig's name; use %q or %q",
			ErrAmbiguous, r.Value, "id="+r.Value, "name="+r.Value)
	case byID >= 0:
		return byID, nil
	default:
		return byName, nil
	}
}

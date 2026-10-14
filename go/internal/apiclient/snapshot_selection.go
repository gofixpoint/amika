package apiclient

import (
	"encoding/json"
	"errors"
)

// SnapshotSelection is the value of CreateSandboxRequest.Snapshot, which the
// API reads three ways:
//
//   - absent (the zero value): apply the default snapshot chain, the
//     repository's default snapshot, else the organization's, else the
//     preset's base image
//   - null (NoSnapshot): skip both default snapshots and boot the preset's
//     base image
//   - a slug (SnapshotSlug): fork that captured snapshot
//
// The field must be tagged `omitzero`, since JSON can only express "absent"
// by leaving the key out.
type SnapshotSelection struct {
	slug string
	null bool
}

// NoSnapshot selects an explicit JSON null, which skips the repository and
// organization default snapshots.
func NoSnapshot() SnapshotSelection {
	return SnapshotSelection{null: true}
}

// SnapshotSlug selects the captured snapshot with the given slug. An empty
// slug is the zero value, so the field is omitted rather than sent as "".
func SnapshotSlug(slug string) SnapshotSelection {
	return SnapshotSelection{slug: slug}
}

// IsZero reports whether the selection is absent, which `omitzero` uses to
// leave the key out of the request body.
func (s SnapshotSelection) IsZero() bool {
	return !s.null && s.slug == ""
}

// errSnapshotSelectionZero is returned when the zero value reaches
// MarshalJSON. Encoding it as null would silently opt the rig out of the
// default snapshots, so a field missing its `omitzero` tag fails loudly
// instead.
var errSnapshotSelectionZero = errors.New("apiclient: the zero SnapshotSelection must be omitted; tag the field `omitzero`")

// MarshalJSON encodes the selection as null or as the slug string.
//
// IsZero and MarshalJSON have value receivers because CreateSandbox passes
// the request to encoding/json by value, where pointer-receiver methods on a
// field are never called.
func (s SnapshotSelection) MarshalJSON() ([]byte, error) {
	switch {
	case s.null:
		return []byte("null"), nil
	case s.slug == "":
		return nil, errSnapshotSelectionZero
	default:
		return json.Marshal(s.slug)
	}
}

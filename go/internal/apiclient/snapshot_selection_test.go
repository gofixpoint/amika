package apiclient

import (
	"encoding/json"
	"strings"
	"testing"
)

var snapshotSelectionCases = []struct {
	name      string
	selection SnapshotSelection
	// wantRaw is the encoded `snapshot` value, or "" for an absent key.
	wantRaw string
}{
	{name: "zero value is omitted", selection: SnapshotSelection{}},
	{name: "empty slug is omitted", selection: SnapshotSlug("")},
	{name: "NoSnapshot sends null", selection: NoSnapshot(), wantRaw: "null"},
	{name: "slug is sent", selection: SnapshotSlug("amika-mono-base"), wantRaw: `"amika-mono-base"`},
}

// Marshaled by value, as CreateSandbox does: pointer-receiver IsZero or
// MarshalJSON methods would be skipped here and the null case would be lost.
func TestCreateSandboxRequestSnapshotJSON(t *testing.T) {
	for _, tt := range snapshotSelectionCases {
		t.Run(tt.name, func(t *testing.T) {
			data, err := json.Marshal(CreateSandboxRequest{Name: "dev", Snapshot: tt.selection})
			if err != nil {
				t.Fatalf("Marshal: %v", err)
			}
			assertSnapshotKey(t, data, tt.wantRaw)
		})
	}
}

// Without `omitzero` the zero value would have to encode as something, and
// null would silently skip the default snapshots.
func TestSnapshotSelectionZeroValueRefusesToEncode(t *testing.T) {
	_, err := json.Marshal(struct {
		Snapshot SnapshotSelection `json:"snapshot"`
	}{})
	if err == nil || !strings.Contains(err.Error(), "omitzero") {
		t.Errorf("err = %v, want one pointing at the omitzero tag", err)
	}
}

func assertSnapshotKey(t *testing.T, body []byte, wantRaw string) {
	t.Helper()
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(body, &fields); err != nil {
		t.Fatalf("decoding body %s: %v", body, err)
	}
	raw, present := fields["snapshot"]
	if wantRaw == "" {
		if present {
			t.Errorf("body carries snapshot=%s, want it absent: %s", raw, body)
		}
		return
	}
	if !present {
		t.Fatalf("body has no snapshot key, want %s: %s", wantRaw, body)
	}
	if string(raw) != wantRaw {
		t.Errorf("snapshot = %s, want %s", raw, wantRaw)
	}
}

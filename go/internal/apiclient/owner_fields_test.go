package apiclient

import (
	"encoding/json"
	"reflect"
	"testing"
)

// TestOwnerFieldsRoundTrip checks that decoding an API response and
// re-encoding it for `-o json` keeps the ownership fields with the API's
// names and values, for an org-owned and an end-user-owned resource.
func TestOwnerFieldsRoundTrip(t *testing.T) {
	orgOwner := map[string]any{"kind": "org"}
	endUserOwner := map[string]any{"kind": "end_user", "external_id": "customer-42"}

	tests := []struct {
		name   string
		fields map[string]any
		decode func([]byte) (any, error)
	}{
		{
			name:   "rig owned by the org",
			fields: map[string]any{"owner": orgOwner},
			decode: roundTripAs[RemoteSandbox],
		},
		{
			name:   "rig owned by an end-user",
			fields: map[string]any{"owner": endUserOwner},
			decode: roundTripAs[RemoteSandbox],
		},
		{
			name:   "host owned by the org",
			fields: map[string]any{"owner": orgOwner, "end_user_id": nil},
			decode: roundTripAs[Host],
		},
		{
			name:   "host owned by an end-user",
			fields: map[string]any{"owner": endUserOwner, "end_user_id": "eu_123"},
			decode: roundTripAs[Host],
		},
		{
			name: "snapshot owned by the org",
			fields: map[string]any{
				"owner":            orgOwner,
				"end_user_id":      nil,
				"cloud_account_id": "ca_123",
			},
			decode: roundTripAs[SandboxSnapshot],
		},
		{
			name: "snapshot owned by an end-user",
			fields: map[string]any{
				"owner":            endUserOwner,
				"end_user_id":      "eu_123",
				"cloud_account_id": nil,
			},
			decode: roundTripAs[SandboxSnapshot],
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			in, err := json.Marshal(tt.fields)
			if err != nil {
				t.Fatalf("marshal input: %v", err)
			}
			got, err := tt.decode(in)
			if err != nil {
				t.Fatalf("round trip: %v", err)
			}
			out := got.(map[string]any)
			for key, want := range tt.fields {
				value, ok := out[key]
				if !ok {
					t.Errorf("re-encoded output lacks %q", key)
					continue
				}
				if !reflect.DeepEqual(value, want) {
					t.Errorf("%q = %#v, want %#v", key, value, want)
				}
			}
		})
	}
}

// roundTripAs decodes data into T, re-encodes it, and returns the result as a
// generic JSON object.
func roundTripAs[T any](data []byte) (any, error) {
	var v T
	if err := json.Unmarshal(data, &v); err != nil {
		return nil, err
	}
	encoded, err := json.Marshal(v)
	if err != nil {
		return nil, err
	}
	var out map[string]any
	if err := json.Unmarshal(encoded, &out); err != nil {
		return nil, err
	}
	return out, nil
}

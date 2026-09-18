package sandboxcmd

import (
	"reflect"
	"strings"
	"testing"
)

func TestParseSecretFlags(t *testing.T) {
	tests := []struct {
		name    string
		flags   []string
		want    map[string]string
		wantErr string
	}{
		{
			name:  "env with explicit env var",
			flags: []string{"env:FOO=MY_SECRET"},
			want:  map[string]string{"FOO": "MY_SECRET"},
		},
		{
			name:  "env shorthand",
			flags: []string{"env:MY_SECRET"},
			want:  map[string]string{"MY_SECRET": "MY_SECRET"},
		},
		{
			name:  "multiple secrets",
			flags: []string{"env:FOO=SECRET_A", "env:BAR=SECRET_B"},
			want:  map[string]string{"FOO": "SECRET_A", "BAR": "SECRET_B"},
		},
		{
			name:  "no flags",
			flags: nil,
			want:  nil,
		},
		{
			name:    "missing type prefix",
			flags:   []string{"MY_SECRET"},
			wantErr: "expected type prefix",
		},
		{
			name:    "empty after env:",
			flags:   []string{"env:"},
			wantErr: "empty env var name",
		},
		{
			name:    "empty env var name",
			flags:   []string{"env:=SECRET"},
			wantErr: "empty env var name",
		},
		{
			name:    "empty secret name",
			flags:   []string{"env:FOO="},
			wantErr: "empty secret name",
		},
		{
			name:    "duplicate env var",
			flags:   []string{"env:FOO=SECRET_A", "env:FOO=SECRET_B"},
			wantErr: "duplicate env var",
		},
		{
			name:    "file type not supported",
			flags:   []string{"file:/path=SECRET"},
			wantErr: "not yet supported",
		},
		{
			name:    "unknown type prefix",
			flags:   []string{"unknown:FOO"},
			wantErr: "unknown secret type",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := parseSecretFlags(tt.flags)
			if tt.wantErr != "" {
				if err == nil {
					t.Fatalf("expected error containing %q, got nil", tt.wantErr)
				}
				if !strings.Contains(err.Error(), tt.wantErr) {
					t.Fatalf("error %q does not contain %q", err.Error(), tt.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if !reflect.DeepEqual(got, tt.want) {
				t.Errorf("got %+v, want %+v", got, tt.want)
			}
		})
	}
}

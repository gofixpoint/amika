package auth

import (
	"os"
	"strings"
	"testing"
)

func TestAPIKey_SaveLoadDelete(t *testing.T) {
	t.Setenv("AMIKA_STATE_DIRECTORY", t.TempDir())

	if got, err := LoadAPIKey(); err != nil || got != nil {
		t.Fatalf("LoadAPIKey before save = (%v, %v), want (nil, nil)", got, err)
	}

	if err := SaveAPIKey(APIKeyAuth{Key: "sk_test_123"}); err != nil {
		t.Fatalf("SaveAPIKey: %v", err)
	}

	loaded, err := LoadAPIKey()
	if err != nil {
		t.Fatalf("LoadAPIKey: %v", err)
	}
	if loaded == nil || loaded.Key != "sk_test_123" {
		t.Fatalf("loaded = %+v, want key sk_test_123", loaded)
	}

	if err := DeleteAPIKey(); err != nil {
		t.Fatalf("DeleteAPIKey: %v", err)
	}
	if got, err := LoadAPIKey(); err != nil || got != nil {
		t.Fatalf("LoadAPIKey after delete = (%v, %v), want (nil, nil)", got, err)
	}

	// Delete is idempotent.
	if err := DeleteAPIKey(); err != nil {
		t.Fatalf("DeleteAPIKey idempotent: %v", err)
	}
}

func TestAPIKey_FilePermissions(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("AMIKA_STATE_DIRECTORY", dir)

	if err := SaveAPIKey(APIKeyAuth{Key: "sk_test_perm"}); err != nil {
		t.Fatalf("SaveAPIKey: %v", err)
	}

	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("ReadDir: %v", err)
	}
	var found bool
	for _, e := range entries {
		if e.Name() != "api-key.json" {
			continue
		}
		found = true
		info, err := e.Info()
		if err != nil {
			t.Fatalf("Info: %v", err)
		}
		if mode := info.Mode().Perm(); mode != 0600 {
			t.Fatalf("api-key.json perms = %o, want 0600", mode)
		}
	}
	if !found {
		t.Fatalf("api-key.json not created in %s", dir)
	}
}

func TestReadAPIKeyFromReader(t *testing.T) {
	tests := []struct {
		name    string
		input   string
		want    string
		wantErr bool
	}{
		{name: "trimmed", input: "  sk_abc  \n", want: "sk_abc"},
		{name: "newline only", input: "\n\n\n", wantErr: true},
		{name: "empty", input: "", wantErr: true},
		{name: "embedded whitespace preserved", input: "sk_a b\n", want: "sk_a b"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := ReadAPIKeyFromReader(strings.NewReader(tt.input))
			if tt.wantErr {
				if err == nil {
					t.Fatalf("want error, got key %q", got)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if got != tt.want {
				t.Fatalf("got %q, want %q", got, tt.want)
			}
		})
	}
}

func TestAPIKey_CorruptFile(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("AMIKA_STATE_DIRECTORY", dir)

	// Write a file with empty key.
	if err := SaveAPIKey(APIKeyAuth{Key: "sk_x"}); err != nil {
		t.Fatalf("SaveAPIKey: %v", err)
	}
	if err := os.WriteFile(dir+"/api-key.json", []byte(`{"key":""}`), 0600); err != nil {
		t.Fatalf("overwrite: %v", err)
	}
	if _, err := LoadAPIKey(); err == nil {
		t.Fatal("expected error for empty key")
	}
}

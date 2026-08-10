package apiclient

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func newTestClient(t *testing.T, handler http.HandlerFunc) *Client {
	t.Helper()
	srv := httptest.NewServer(handler)
	t.Cleanup(srv.Close)
	return NewClient(srv.URL, "test-token")
}

func TestListSSHPublicKeys(t *testing.T) {
	var gotPath, gotMethod string
	c := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		gotPath, gotMethod = r.URL.Path, r.Method
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode([]map[string]string{
			{"id": "specsec_1", "name": "laptop", "public_key": "ssh-ed25519 AAAA", "scope": "user"},
		})
	})

	keys, err := c.ListSSHPublicKeys()
	if err != nil {
		t.Fatalf("ListSSHPublicKeys: %v", err)
	}
	if gotMethod != "GET" || gotPath != "/api/v0beta1/secrets/ssh-public-keys" {
		t.Errorf("requested %s %s", gotMethod, gotPath)
	}
	if len(keys) != 1 || keys[0].ID != "specsec_1" || keys[0].PublicKey != "ssh-ed25519 AAAA" {
		t.Errorf("unexpected keys: %+v", keys)
	}
}

func TestListSSHPublicKeys_ErrorIsWrapped(t *testing.T) {
	c := newTestClient(t, func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	})

	if _, err := c.ListSSHPublicKeys(); err == nil {
		t.Fatal("expected an error")
	} else if !strings.Contains(err.Error(), "remote list SSH public keys") {
		t.Errorf("error not wrapped with context: %v", err)
	}
}

func TestDeleteSSHPublicKey(t *testing.T) {
	var gotPath, gotMethod string
	c := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		gotPath, gotMethod = r.URL.Path, r.Method
		w.WriteHeader(http.StatusNoContent)
	})

	if err := c.DeleteSSHPublicKey("specsec_1"); err != nil {
		t.Fatalf("DeleteSSHPublicKey: %v", err)
	}
	if gotMethod != "DELETE" || gotPath != "/api/v0beta1/secrets/ssh-public-keys/specsec_1" {
		t.Errorf("requested %s %s", gotMethod, gotPath)
	}
}

func TestDeleteSSHPublicKey_EscapesID(t *testing.T) {
	var gotPath string
	c := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		// r.URL.Path is already decoded; comparing it proves the id survived
		// the round trip intact rather than being split into extra segments.
		gotPath = r.URL.Path
		w.WriteHeader(http.StatusNoContent)
	})

	// A slash in the id must not create a new path segment.
	if err := c.DeleteSSHPublicKey("weird/id with space"); err != nil {
		t.Fatalf("DeleteSSHPublicKey: %v", err)
	}
	const want = "/api/v0beta1/secrets/ssh-public-keys/weird/id with space"
	if gotPath != want {
		t.Errorf("path = %q, want %q", gotPath, want)
	}
}

func TestDeleteSSHPublicKey_NotFoundIsWrapped(t *testing.T) {
	c := newTestClient(t, func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNotFound)
		w.Write([]byte(`{"type":"error","error_code":"secret_not_found","message":"SSH public key not found"}`))
	})

	err := c.DeleteSSHPublicKey("specsec_missing")
	if err == nil {
		t.Fatal("expected an error")
	}
	if !strings.Contains(err.Error(), "SSH public key not found") {
		t.Errorf("error should surface the server message: %v", err)
	}
}

func TestCanonicalEd25519PublicKey(t *testing.T) {
	// A real ed25519 key, with and without a trailing comment.
	const key = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAICnkEhANFgFv22EqdQvj/IIjVWJ7zKiKeUR1hk/bZSvj"
	tests := []struct {
		name, in, want string
	}{
		{"bare key round-trips", key, key},
		{"comment is stripped", key + " me@host", key},
		{"extra whitespace is tolerated", "  " + key + "  ", key},
		{"rsa is rejected", "ssh-rsa AAAAB3NzaC1yc2E", ""},
		{"garbage is rejected", "not a key", ""},
		{"empty is rejected", "", ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := CanonicalEd25519PublicKey(tt.in); got != tt.want {
				t.Errorf("CanonicalEd25519PublicKey(%q) = %q, want %q", tt.in, got, tt.want)
			}
		})
	}
}

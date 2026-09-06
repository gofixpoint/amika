package main

import (
	"crypto/ed25519"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"

	"github.com/gofixpoint/amika/go/internal/apiclient"
	"github.com/spf13/cobra"
)

// sshKeyAPI records what the CLI sent so a test can assert on the request, not
// just the rendered output.
type sshKeyAPI struct {
	mu       sync.Mutex
	existing []map[string]string
	created  []map[string]string
	deleted  []string
	// deleteStatus is the status the DELETE endpoint answers with.
	deleteStatus int
}

// setupMockSSHKeyAPI stands up a stub control plane for the ssh-key endpoints
// and returns the env that points the CLI at it.
func setupMockSSHKeyAPI(t *testing.T, api *sshKeyAPI) []string {
	t.Helper()
	if api.deleteStatus == 0 {
		api.deleteStatus = http.StatusNoContent
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		const base = "/api/v0beta1/secrets/ssh-public-keys"
		switch {
		case r.Method == "GET" && r.URL.Path == base:
			api.mu.Lock()
			existing := api.existing
			api.mu.Unlock()
			if existing == nil {
				existing = []map[string]string{}
			}
			json.NewEncoder(w).Encode(existing)
		case r.Method == "POST" && r.URL.Path == base:
			var body map[string]string
			json.NewDecoder(r.Body).Decode(&body)
			api.mu.Lock()
			api.created = append(api.created, body)
			// Model the real endpoint: it upserts by name, so an existing
			// name keeps its id and has its material replaced. Without this
			// the --force tests would pass even if the server 409'd or
			// created a duplicate row.
			id := "specsec_new"
			replaced := false
			for i, item := range api.existing {
				if item["name"] == body["name"] {
					id = item["id"]
					api.existing[i]["public_key"] = body["public_key"]
					replaced = true
					break
				}
			}
			if !replaced {
				api.existing = append(api.existing, map[string]string{
					"id": id, "name": body["name"],
					"public_key": body["public_key"], "scope": "user",
				})
			}
			api.mu.Unlock()
			w.WriteHeader(http.StatusCreated)
			json.NewEncoder(w).Encode(map[string]string{
				"id":         id,
				"name":       body["name"],
				"public_key": body["public_key"],
				"scope":      "user",
			})
		case r.Method == "DELETE" && strings.HasPrefix(r.URL.Path, base+"/"):
			api.mu.Lock()
			api.deleted = append(api.deleted, strings.TrimPrefix(r.URL.Path, base+"/"))
			status := api.deleteStatus
			api.mu.Unlock()
			if status == http.StatusNoContent {
				w.WriteHeader(status)
				return
			}
			w.WriteHeader(status)
			json.NewEncoder(w).Encode(map[string]string{
				"type":       "error",
				"error_code": "secret_not_found",
				"message":    "SSH public key not found",
			})
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	t.Cleanup(srv.Close)
	return withEnv(os.Environ(),
		"AMIKA_API_URL="+srv.URL,
		"AMIKA_API_KEY=test-bearer-token",
	)
}

// writeTestPubKey writes a valid ed25519 .pub file and returns its path plus
// the canonical `ssh-ed25519 <blob>` line the CLI should upload.
func writeTestPubKey(t *testing.T, dir, comment string) (string, string) {
	t.Helper()
	pub, _, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	const algo = "ssh-ed25519"
	blob := make([]byte, 0, 4+len(algo)+4+len(pub))
	blob = binary.BigEndian.AppendUint32(blob, uint32(len(algo)))
	blob = append(blob, algo...)
	blob = binary.BigEndian.AppendUint32(blob, uint32(len(pub)))
	blob = append(blob, pub...)
	encoded := base64.StdEncoding.EncodeToString(blob)
	path := filepath.Join(dir, "test_key.pub")
	if err := os.WriteFile(path, []byte(algo+" "+encoded+" "+comment+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	return path, algo + " " + encoded
}

func TestSecretSSHKeyPush(t *testing.T) {
	bin := buildAmika(t)
	api := &sshKeyAPI{}
	env := setupMockSSHKeyAPI(t, api)
	pubPath, canonical := writeTestPubKey(t, t.TempDir(), "me@host")

	cmd := exec.Command(bin, "secret", "ssh-key", "push", "--name", "laptop", "--from-file", pubPath)
	cmd.Env = env
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("push failed: %v\n%s", err, out)
	}
	if !strings.Contains(string(out), `Created SSH public key "laptop"`) {
		t.Errorf("unexpected output: %s", out)
	}
	if len(api.created) != 1 {
		t.Fatalf("expected 1 create, got %d", len(api.created))
	}
	if api.created[0]["name"] != "laptop" {
		t.Errorf("name = %q, want laptop", api.created[0]["name"])
	}
	// The comment must be stripped before upload so the stored value matches
	// what the server canonicalizes to.
	if api.created[0]["public_key"] != canonical {
		t.Errorf("public_key = %q, want %q", api.created[0]["public_key"], canonical)
	}
}

func TestSecretSSHKeyPush_ConflictWithoutForce(t *testing.T) {
	bin := buildAmika(t)
	api := &sshKeyAPI{existing: []map[string]string{
		{"id": "specsec_old", "name": "laptop", "public_key": "ssh-ed25519 AAAA", "scope": "user"},
	}}
	env := setupMockSSHKeyAPI(t, api)
	pubPath, _ := writeTestPubKey(t, t.TempDir(), "me@host")

	cmd := exec.Command(bin, "secret", "ssh-key", "push", "--name", "laptop", "--from-file", pubPath)
	cmd.Env = env
	out, err := cmd.CombinedOutput()
	if err == nil {
		t.Fatalf("expected a non-zero exit, got success:\n%s", out)
	}
	if !strings.Contains(string(out), "already exists with different key material; pass --force") {
		t.Errorf("unexpected output: %s", out)
	}
	// Nothing may be uploaded when the push is refused.
	if len(api.created) != 0 {
		t.Errorf("expected no create, got %d", len(api.created))
	}
}

func TestSecretSSHKeyPush_Force(t *testing.T) {
	bin := buildAmika(t)
	api := &sshKeyAPI{existing: []map[string]string{
		{"id": "specsec_old", "name": "laptop", "public_key": "ssh-ed25519 AAAA", "scope": "user"},
	}}
	env := setupMockSSHKeyAPI(t, api)
	pubPath, canonical := writeTestPubKey(t, t.TempDir(), "me@host")

	cmd := exec.Command(bin, "secret", "ssh-key", "push", "--name", "laptop", "--from-file", pubPath, "--force")
	cmd.Env = env
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("push --force failed: %v\n%s", err, out)
	}
	if !strings.Contains(string(out), `Updated SSH public key "laptop"`) {
		t.Errorf("unexpected output: %s", out)
	}
	if len(api.created) != 1 || api.created[0]["public_key"] != canonical {
		t.Errorf("expected one create with the new key, got %+v", api.created)
	}
	// The create endpoint upserts, so --force must not delete first.
	if len(api.deleted) != 0 {
		t.Errorf("expected no deletes, got %v", api.deleted)
	}
	// The stub models the upsert, so the row must have been replaced in
	// place rather than duplicated.
	if len(api.existing) != 1 || api.existing[0]["id"] != "specsec_old" {
		t.Errorf("expected the existing row to be replaced in place, got %+v", api.existing)
	}
	if api.existing[0]["public_key"] != canonical {
		t.Errorf("stored key was not replaced: %+v", api.existing[0])
	}
}

func TestSecretSSHKeyPush_ForceJSONStatus(t *testing.T) {
	bin := buildAmika(t)
	api := &sshKeyAPI{existing: []map[string]string{
		{"id": "specsec_old", "name": "laptop", "public_key": "ssh-ed25519 AAAA", "scope": "user"},
	}}
	env := setupMockSSHKeyAPI(t, api)
	pubPath, _ := writeTestPubKey(t, t.TempDir(), "me@host")

	cmd := exec.Command(bin, "secret", "ssh-key", "push", "--name", "laptop", "--from-file", pubPath, "--force", "-o", "json")
	cmd.Env = env
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("push failed: %v\n%s", err, out)
	}
	// Remote-backed commands emit the API response schema unchanged, so the
	// payload must be exactly SSHPublicKeySummary: no synthetic `status`, and
	// no dropped `public_key`.
	var raw map[string]any
	if err := json.Unmarshal(out, &raw); err != nil {
		t.Fatalf("output is not JSON: %v\n%s", err, out)
	}
	wantKeys := map[string]bool{"id": true, "name": true, "public_key": true, "scope": true}
	for k := range raw {
		if !wantKeys[k] {
			t.Errorf("unexpected key %q in push JSON: %v", k, raw)
		}
	}
	for k := range wantKeys {
		if _, ok := raw[k]; !ok {
			t.Errorf("missing key %q in push JSON: %v", k, raw)
		}
	}
	if raw["name"] != "laptop" || raw["scope"] != "user" {
		t.Errorf("unexpected JSON: %v", raw)
	}
}

func TestSecretSSHKeyPush_RejectsNonEd25519(t *testing.T) {
	bin := buildAmika(t)
	api := &sshKeyAPI{}
	env := setupMockSSHKeyAPI(t, api)
	dir := t.TempDir()
	pubPath := filepath.Join(dir, "bad.pub")
	if err := os.WriteFile(pubPath, []byte("ssh-rsa AAAAB3NzaC1yc2E not-ed25519\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	cmd := exec.Command(bin, "secret", "ssh-key", "push", "--from-file", pubPath)
	cmd.Env = env
	out, err := cmd.CombinedOutput()
	if err == nil {
		t.Fatalf("expected a non-zero exit, got success:\n%s", out)
	}
	if !strings.Contains(string(out), "is not a valid ed25519 public key") {
		t.Errorf("unexpected output: %s", out)
	}
	// A local validation failure must not reach the API at all.
	if len(api.created) != 0 {
		t.Errorf("expected no create, got %d", len(api.created))
	}
}

func TestSecretSSHKeyList(t *testing.T) {
	bin := buildAmika(t)
	api := &sshKeyAPI{existing: []map[string]string{
		{"id": "specsec_1", "name": "laptop", "public_key": "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIabcdefghijkl", "scope": "user"},
	}}
	env := setupMockSSHKeyAPI(t, api)

	cmd := exec.Command(bin, "secret", "ssh-key", "list")
	cmd.Env = env
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("list failed: %v\n%s", err, out)
	}
	for _, want := range []string{"ID", "NAME", "KEY", "specsec_1", "laptop"} {
		if !strings.Contains(string(out), want) {
			t.Errorf("output missing %q: %s", want, out)
		}
	}
}

func TestSecretSSHKeyList_EmptyJSONIsArray(t *testing.T) {
	bin := buildAmika(t)
	env := setupMockSSHKeyAPI(t, &sshKeyAPI{})

	cmd := exec.Command(bin, "secret", "ssh-key", "list", "-o", "json")
	cmd.Env = env
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("list failed: %v\n%s", err, out)
	}
	// JSON consumers must never have to handle `null` here.
	if strings.TrimSpace(string(out)) != "[]" {
		t.Errorf("output = %q, want []", out)
	}
}

func TestSecretSSHKeyList_EmptyText(t *testing.T) {
	bin := buildAmika(t)
	env := setupMockSSHKeyAPI(t, &sshKeyAPI{})

	cmd := exec.Command(bin, "secret", "ssh-key", "list")
	cmd.Env = env
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("list failed: %v\n%s", err, out)
	}
	if !strings.Contains(string(out), "No SSH public keys found.") {
		t.Errorf("unexpected output: %s", out)
	}
}

func TestSecretSSHKeyDelete(t *testing.T) {
	bin := buildAmika(t)
	api := &sshKeyAPI{}
	env := setupMockSSHKeyAPI(t, api)

	cmd := exec.Command(bin, "secret", "ssh-key", "delete", "specsec_1", "--force")
	cmd.Env = env
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("delete failed: %v\n%s", err, out)
	}
	if !strings.Contains(string(out), "Deleted SSH public key specsec_1") {
		t.Errorf("unexpected output: %s", out)
	}
	if len(api.deleted) != 1 || api.deleted[0] != "specsec_1" {
		t.Errorf("deleted = %v, want [specsec_1]", api.deleted)
	}
}

func TestSecretSSHKeyDelete_JSON(t *testing.T) {
	bin := buildAmika(t)
	env := setupMockSSHKeyAPI(t, &sshKeyAPI{})

	cmd := exec.Command(bin, "secret", "ssh-key", "rm", "specsec_1", "--force", "-o", "json")
	cmd.Env = env
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("delete failed: %v\n%s", err, out)
	}
	var got struct {
		Name   string `json:"name"`
		Status string `json:"status"`
	}
	if err := json.Unmarshal(out, &got); err != nil {
		t.Fatalf("output is not JSON: %v\n%s", err, out)
	}
	if got.Name != "specsec_1" || got.Status != "deleted" {
		t.Errorf("unexpected JSON: %+v", got)
	}
}

func TestSecretSSHKeyDelete_NotFound(t *testing.T) {
	bin := buildAmika(t)
	api := &sshKeyAPI{deleteStatus: http.StatusNotFound}
	env := setupMockSSHKeyAPI(t, api)

	cmd := exec.Command(bin, "secret", "ssh-key", "delete", "specsec_missing", "--force")
	cmd.Env = env
	out, err := cmd.CombinedOutput()
	if err == nil {
		t.Fatalf("expected a non-zero exit, got success:\n%s", out)
	}
	if !strings.Contains(string(out), "SSH public key not found") {
		t.Errorf("unexpected output: %s", out)
	}
}

// The tests below drive the command tree in-process instead of as a
// subprocess. Subprocess tests assert the real end-to-end behavior but record
// no coverage for this package, so the RunE bodies are exercised here too.

// setupInProcessSSHKeyAPI points the in-process command tree at a stub API.
func setupInProcessSSHKeyAPI(t *testing.T, api *sshKeyAPI) {
	t.Helper()
	env := setupMockSSHKeyAPI(t, api)
	for _, entry := range env {
		key, value, found := strings.Cut(entry, "=")
		if !found {
			continue
		}
		switch key {
		case "AMIKA_API_URL", "AMIKA_API_KEY":
			t.Setenv(key, value)
		}
	}
}

func TestSSHKeyListInProcess(t *testing.T) {
	api := &sshKeyAPI{existing: []map[string]string{
		{"id": "specsec_1", "name": "laptop", "public_key": "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIabcdefghijkl", "scope": "user"},
	}}
	setupInProcessSSHKeyAPI(t, api)

	out, err := runRootCommandOutput(t, "secret", "ssh-key", "list")
	if err != nil {
		t.Fatalf("list failed: %v\n%s", err, out)
	}
	for _, want := range []string{"ID", "NAME", "KEY", "specsec_1", "laptop"} {
		if !strings.Contains(out, want) {
			t.Errorf("output missing %q: %s", want, out)
		}
	}
	// The blob must be abbreviated rather than printed in full.
	if strings.Contains(out, "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIabcdefghijkl") {
		t.Errorf("expected an abbreviated key, got: %s", out)
	}
}

func TestSSHKeyListInProcess_EmptyJSONIsArray(t *testing.T) {
	setupInProcessSSHKeyAPI(t, &sshKeyAPI{})

	out, err := runRootCommandOutput(t, "secret", "ssh-key", "list", "-o", "json")
	if err != nil {
		t.Fatalf("list failed: %v", err)
	}
	if out != "[]\n" {
		t.Fatalf("empty list JSON = %q, want %q", out, "[]\n")
	}
}

func TestSSHKeyListInProcess_EmptyText(t *testing.T) {
	setupInProcessSSHKeyAPI(t, &sshKeyAPI{})

	out, err := runRootCommandOutput(t, "secret", "ssh-key", "list")
	if err != nil {
		t.Fatalf("list failed: %v", err)
	}
	if !strings.Contains(out, "No SSH public keys found.") {
		t.Errorf("unexpected output: %s", out)
	}
}

func TestSSHKeyDeleteInProcess(t *testing.T) {
	api := &sshKeyAPI{}
	setupInProcessSSHKeyAPI(t, api)

	out, err := runRootCommandOutput(t, "secret", "ssh-key", "delete", "specsec_1", "--force")
	if err != nil {
		t.Fatalf("delete failed: %v\n%s", err, out)
	}
	if !strings.Contains(out, "Deleted SSH public key specsec_1") {
		t.Errorf("unexpected output: %s", out)
	}
	if len(api.deleted) != 1 || api.deleted[0] != "specsec_1" {
		t.Errorf("deleted = %v, want [specsec_1]", api.deleted)
	}
}

func TestSSHKeyDeleteInProcess_JSON(t *testing.T) {
	setupInProcessSSHKeyAPI(t, &sshKeyAPI{})

	out, err := runRootCommandOutput(t, "secret", "ssh-key", "rm", "specsec_1", "--force", "-o", "json")
	if err != nil {
		t.Fatalf("delete failed: %v", err)
	}
	var got struct {
		Name   string `json:"name"`
		Status string `json:"status"`
	}
	if err := json.Unmarshal([]byte(out), &got); err != nil {
		t.Fatalf("output is not JSON: %v\n%s", err, out)
	}
	if got.Name != "specsec_1" || got.Status != "deleted" {
		t.Errorf("unexpected JSON: %+v", got)
	}
}

func TestSSHKeyDeleteInProcess_NotFound(t *testing.T) {
	setupInProcessSSHKeyAPI(t, &sshKeyAPI{deleteStatus: http.StatusNotFound})

	_, err := runRootCommandOutput(t, "secret", "ssh-key", "delete", "specsec_missing", "--force")
	if err == nil {
		t.Fatal("expected an error for a missing key")
	}
	if !strings.Contains(err.Error(), "SSH public key not found") {
		t.Errorf("unexpected error: %v", err)
	}
}

func TestSSHKeyPushInProcess(t *testing.T) {
	api := &sshKeyAPI{}
	setupInProcessSSHKeyAPI(t, api)
	pubPath, canonical := writeTestPubKey(t, t.TempDir(), "me@host")

	out, err := runRootCommandOutput(t, "secret", "ssh-key", "push", "--name", "laptop", "--from-file", pubPath)
	if err != nil {
		t.Fatalf("push failed: %v\n%s", err, out)
	}
	if !strings.Contains(out, `Created SSH public key "laptop"`) {
		t.Errorf("unexpected output: %s", out)
	}
	if len(api.created) != 1 || api.created[0]["public_key"] != canonical {
		t.Errorf("unexpected create payload: %+v", api.created)
	}
}

func TestSSHKeyPushInProcess_ConflictWithoutForce(t *testing.T) {
	api := &sshKeyAPI{existing: []map[string]string{
		{"id": "specsec_old", "name": "laptop", "public_key": "ssh-ed25519 AAAA", "scope": "user"},
	}}
	setupInProcessSSHKeyAPI(t, api)
	pubPath, _ := writeTestPubKey(t, t.TempDir(), "me@host")

	_, err := runRootCommandOutput(t, "secret", "ssh-key", "push", "--name", "laptop", "--from-file", pubPath)
	if err == nil {
		t.Fatal("expected an error when the name already exists")
	}
	if !strings.Contains(err.Error(), "already exists with different key material; pass --force") {
		t.Errorf("unexpected error: %v", err)
	}
	if len(api.created) != 0 {
		t.Errorf("expected no create, got %d", len(api.created))
	}
}

func TestSSHKeyPushInProcess_Force(t *testing.T) {
	api := &sshKeyAPI{existing: []map[string]string{
		{"id": "specsec_old", "name": "laptop", "public_key": "ssh-ed25519 AAAA", "scope": "user"},
	}}
	setupInProcessSSHKeyAPI(t, api)
	pubPath, _ := writeTestPubKey(t, t.TempDir(), "me@host")

	out, err := runRootCommandOutput(t, "secret", "ssh-key", "push", "--name", "laptop", "--from-file", pubPath, "--force")
	if err != nil {
		t.Fatalf("push --force failed: %v\n%s", err, out)
	}
	if !strings.Contains(out, `Updated SSH public key "laptop"`) {
		t.Errorf("unexpected output: %s", out)
	}
	if len(api.deleted) != 0 {
		t.Errorf("upsert must not delete first, got %v", api.deleted)
	}
}

func TestSSHKeyPushInProcess_EmptyNameRejected(t *testing.T) {
	setupInProcessSSHKeyAPI(t, &sshKeyAPI{})
	pubPath, _ := writeTestPubKey(t, t.TempDir(), "me@host")

	_, err := runRootCommandOutput(t, "secret", "ssh-key", "push", "--name", "  ", "--from-file", pubPath)
	if err == nil {
		t.Fatal("expected an error for an empty name")
	}
	if !strings.Contains(err.Error(), "--name must not be empty") {
		t.Errorf("unexpected error: %v", err)
	}
}

func TestSSHKeyPushInProcess_MissingFile(t *testing.T) {
	setupInProcessSSHKeyAPI(t, &sshKeyAPI{})

	_, err := runRootCommandOutput(t, "secret", "ssh-key", "push", "--from-file", filepath.Join(t.TempDir(), "nope.pub"))
	if err == nil {
		t.Fatal("expected an error for a missing file")
	}
	if !strings.Contains(err.Error(), "reading public key") {
		t.Errorf("unexpected error: %v", err)
	}
}

func TestAbbreviateSSHKey(t *testing.T) {
	tests := []struct {
		name  string
		input string
		want  string
	}{
		{
			name:  "long blob is abbreviated",
			input: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIabcdefghijkl comment",
			want:  "ssh-ed25519 AAAAC3Nz...abcdefghijkl",
		},
		{
			name:  "short blob is left alone",
			input: "ssh-ed25519 AAAA",
			want:  "ssh-ed25519 AAAA",
		},
		{
			name:  "a value with no blob is left alone",
			input: "ssh-ed25519",
			want:  "ssh-ed25519",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := abbreviateSSHKey(tt.input); got != tt.want {
				t.Errorf("abbreviateSSHKey(%q) = %q, want %q", tt.input, got, tt.want)
			}
		})
	}
}

func TestSSHKeyPushInProcess_SameMaterialIsNoOpWithoutForce(t *testing.T) {
	pubPath, canonical := writeTestPubKey(t, t.TempDir(), "me@host")
	api := &sshKeyAPI{existing: []map[string]string{
		{"id": "specsec_old", "name": "laptop", "public_key": canonical, "scope": "user"},
	}}
	setupInProcessSSHKeyAPI(t, api)

	// Re-pushing identical material is idempotent, so it must not demand
	// --force. This is what keeps `ssh-keygen` re-runs working.
	out, err := runRootCommandOutput(t, "secret", "ssh-key", "push", "--name", "laptop", "--from-file", pubPath)
	if err != nil {
		t.Fatalf("re-push of identical material failed: %v\n%s", err, out)
	}
	if !strings.Contains(out, "Reuploaded") {
		t.Errorf("unexpected output: %s", out)
	}
}

func TestSSHKeyPushInProcess_DefaultFromFile(t *testing.T) {
	home := t.TempDir()
	if err := os.MkdirAll(filepath.Join(home, ".ssh"), 0o700); err != nil {
		t.Fatal(err)
	}
	pubPath, canonical := writeTestPubKey(t, t.TempDir(), "me@host")
	raw, err := os.ReadFile(pubPath)
	if err != nil {
		t.Fatal(err)
	}
	// The documented default is ~/.ssh/amika_id_ed25519.pub; nothing else
	// exercises that derivation.
	if err := os.WriteFile(filepath.Join(home, ".ssh", "amika_id_ed25519.pub"), raw, 0o644); err != nil {
		t.Fatal(err)
	}
	t.Setenv("HOME", home)

	api := &sshKeyAPI{}
	setupInProcessSSHKeyAPI(t, api)

	out, err := runRootCommandOutput(t, "secret", "ssh-key", "push", "--name", "laptop")
	if err != nil {
		t.Fatalf("push with the default path failed: %v\n%s", err, out)
	}
	if len(api.created) != 1 || api.created[0]["public_key"] != canonical {
		t.Errorf("expected the default key to be uploaded, got %+v", api.created)
	}
	if !strings.Contains(out, "amika_id_ed25519.pub") {
		t.Errorf("output should name the file it read: %s", out)
	}
}

func TestSSHKeyDeleteInProcess_PromptsWithoutForce(t *testing.T) {
	api := &sshKeyAPI{}
	setupInProcessSSHKeyAPI(t, api)

	// Declining at the prompt must leave the key alone.
	rootCmd.SetIn(strings.NewReader("n\n"))
	t.Cleanup(func() { rootCmd.SetIn(nil) })
	out, err := runRootCommandOutput(t, "secret", "ssh-key", "delete", "specsec_1")
	if err != nil {
		t.Fatalf("declining the prompt should not error: %v\n%s", err, out)
	}
	if len(api.deleted) != 0 {
		t.Errorf("declining the prompt still deleted: %v", api.deleted)
	}
}

func TestSSHKeyDeleteInProcess_JSONRequiresForce(t *testing.T) {
	api := &sshKeyAPI{}
	setupInProcessSSHKeyAPI(t, api)

	// Never prompt in JSON mode: without --force this must refuse outright
	// rather than block on stdin.
	_, err := runRootCommandOutput(t, "secret", "ssh-key", "delete", "specsec_1", "-o", "json")
	if err == nil {
		t.Fatal("expected an error when deleting in JSON mode without --force")
	}
	if !strings.Contains(err.Error(), "pass --force") {
		t.Errorf("unexpected error: %v", err)
	}
	if len(api.deleted) != 0 {
		t.Errorf("expected no delete, got %v", api.deleted)
	}
}

func TestSSHKeyDeleteInProcess_RejectsBlankID(t *testing.T) {
	setupInProcessSSHKeyAPI(t, &sshKeyAPI{})

	_, err := runRootCommandOutput(t, "secret", "ssh-key", "delete", "   ", "--force")
	if err == nil {
		t.Fatal("expected an error for a blank id")
	}
	if !strings.Contains(err.Error(), "SSH key ID is required") {
		t.Errorf("unexpected error: %v", err)
	}
}

func TestClassifyUpload(t *testing.T) {
	existing := []apiclient.SSHPublicKeySummary{
		{ID: "specsec_1", Name: "laptop", PublicKey: "ssh-ed25519 AAAA", Scope: "user"},
	}
	tests := []struct {
		name, keyName, publicKey, wantStatus string
		wantConflict                         bool
	}{
		{"new name creates", "desktop", "ssh-ed25519 BBBB", "created", false},
		{"same name same material is a no-op", "laptop", "ssh-ed25519 AAAA", "unchanged", false},
		{"same name new material conflicts", "laptop", "ssh-ed25519 BBBB", "updated", true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := classifyUpload(existing, tt.keyName, tt.publicKey)
			if got.status != tt.wantStatus || got.conflict != tt.wantConflict {
				t.Errorf("classifyUpload = %+v, want status=%q conflict=%v",
					got, tt.wantStatus, tt.wantConflict)
			}
		})
	}
}

func TestSSHKeyPushInProcess_JSONIsTheAPIResponse(t *testing.T) {
	api := &sshKeyAPI{}
	setupInProcessSSHKeyAPI(t, api)
	pubPath, canonical := writeTestPubKey(t, t.TempDir(), "me@host")

	out, err := runRootCommandOutput(t, "secret", "ssh-key", "push",
		"--name", "laptop", "--from-file", pubPath, "-o", "json")
	if err != nil {
		t.Fatalf("push failed: %v\n%s", err, out)
	}
	var raw map[string]any
	if err := json.Unmarshal([]byte(out), &raw); err != nil {
		t.Fatalf("output is not JSON: %v\n%s", err, out)
	}
	// Exactly the API's SSHPublicKeySummary: no synthetic `status` key, and
	// `public_key` preserved.
	if _, ok := raw["status"]; ok {
		t.Errorf("push JSON must not add a status field: %v", raw)
	}
	if raw["public_key"] != canonical {
		t.Errorf("public_key = %v, want %q", raw["public_key"], canonical)
	}
	if len(raw) != 4 {
		t.Errorf("expected exactly the 4 schema fields, got %v", raw)
	}
}

// writeTestKeypair generates a real ed25519 keypair in dir and returns the
// private key path. Unlike writeTestPubKey it produces both halves, which is
// what a push needs before it can register a managed SSH entry for the key.
func writeTestKeypair(t *testing.T, dir string) string {
	t.Helper()
	keyPath := filepath.Join(dir, "id_ed25519")
	if out, err := exec.Command("ssh-keygen", "-t", "ed25519", "-N", "", "-C", "me@host",
		"-f", keyPath).CombinedOutput(); err != nil {
		t.Fatalf("ssh-keygen: %v\n%s", err, out)
	}
	return keyPath
}

// isolateSSHHome points HOME and the state dir at fresh directories, so a test
// that writes SSH config cannot touch the developer's own. Returns the home.
func isolateSSHHome(t *testing.T) string {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	// Set explicitly rather than relying on the HOME fallback: an inherited
	// XDG_STATE_HOME would otherwise put ssh-hosts.json outside the temp home.
	t.Setenv("XDG_STATE_HOME", filepath.Join(home, "state"))
	sshDir := filepath.Join(home, ".ssh")
	if err := os.MkdirAll(sshDir, 0o700); err != nil {
		t.Fatal(err)
	}
	return home
}

func TestSSHKeyPushInProcess_RegistersManagedSSHEntry(t *testing.T) {
	home := isolateSSHHome(t)
	keyPath := writeTestKeypair(t, filepath.Join(home, ".ssh"))

	api := &sshKeyAPI{}
	setupInProcessSSHKeyAPI(t, api)

	out, err := runRootCommandOutput(t, "secret", "ssh-key", "push",
		"--name", "laptop", "--from-file", keyPath+".pub")
	if err != nil {
		t.Fatalf("push failed: %v\n%s", err, out)
	}
	if len(api.created) != 1 {
		t.Fatalf("expected the key to be uploaded, got %+v", api.created)
	}

	// A push must leave behind exactly what `ssh-keygen` leaves behind: the
	// JSON state naming the identity, the config rendered from it, and the
	// Include that makes OpenSSH read that config.
	state, err := os.ReadFile(filepath.Join(home, "state", "amika", "ssh-hosts.json"))
	if err != nil {
		t.Fatalf("ssh-hosts.json was not written: %v", err)
	}
	if !strings.Contains(string(state), keyPath) {
		t.Errorf("ssh-hosts.json does not record the pushed identity:\n%s", state)
	}
	conf, err := os.ReadFile(filepath.Join(home, ".ssh", "amika.conf"))
	if err != nil {
		t.Fatalf("~/.ssh/amika.conf was not written: %v", err)
	}
	if !strings.Contains(string(conf), "IdentityFile "+keyPath) {
		t.Errorf("the managed config does not select the pushed key:\n%s", conf)
	}
	config, err := os.ReadFile(filepath.Join(home, ".ssh", "config"))
	if err != nil {
		t.Fatalf("~/.ssh/config was not written: %v", err)
	}
	if !strings.Contains(string(config), "Include amika.conf") {
		t.Errorf("~/.ssh/config does not include the managed config:\n%s", config)
	}
	if !strings.Contains(out, "Registered the managed SSH host entry") {
		t.Errorf("output should say the entry was registered: %s", out)
	}
}

// The reason later pushes must not adopt: uploaded keys are a set, so a second
// push authorizes another key rather than replacing one — while the entry names
// the single identity every connection authenticates with, under
// `IdentitiesOnly yes`. Re-pointing it here would offer OpenSSH only the newest
// key and cut off every sandbox provisioned against the first.
func TestSSHKeyPushInProcess_SecondPushDoesNotRepointTheIdentity(t *testing.T) {
	home := isolateSSHHome(t)
	firstKey := writeTestKeypair(t, filepath.Join(home, ".ssh"))
	// A second, complete keypair: adopting it is exactly what must not happen.
	secondDir := filepath.Join(home, "other")
	if err := os.MkdirAll(secondDir, 0o700); err != nil {
		t.Fatal(err)
	}
	secondKey := writeTestKeypair(t, secondDir)

	setupInProcessSSHKeyAPI(t, &sshKeyAPI{})

	if out, err := runRootCommandOutput(t, "secret", "ssh-key", "push",
		"--name", "laptop", "--from-file", firstKey+".pub"); err != nil {
		t.Fatalf("first push failed: %v\n%s", err, out)
	}
	out, err := runRootCommandOutput(t, "secret", "ssh-key", "push",
		"--name", "work", "--from-file", secondKey+".pub")
	if err != nil {
		t.Fatalf("second push failed: %v\n%s", err, out)
	}

	conf, err := os.ReadFile(filepath.Join(home, ".ssh", "amika.conf"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(conf), "IdentityFile "+firstKey) {
		t.Errorf("the second push moved the entry off the adopted key:\n%s", conf)
	}
	if strings.Contains(string(conf), secondKey) {
		t.Errorf("the second push adopted its own key:\n%s", conf)
	}
	// The reader has just uploaded a key the entry does not name, so the line
	// has to say which one it does name.
	if !strings.Contains(out, "unchanged") || !strings.Contains(out, firstKey) {
		t.Errorf("output should name the identity still in effect: %s", out)
	}
}

// Idempotent in the strict sense: pushing the same key again reproduces the
// same files, so a re-run cannot drift the config it wrote the first time.
func TestSSHKeyPushInProcess_RepeatPushRewritesTheSameEntry(t *testing.T) {
	home := isolateSSHHome(t)
	keyPath := writeTestKeypair(t, filepath.Join(home, ".ssh"))

	setupInProcessSSHKeyAPI(t, &sshKeyAPI{})

	read := func() (string, string) {
		t.Helper()
		conf, err := os.ReadFile(filepath.Join(home, ".ssh", "amika.conf"))
		if err != nil {
			t.Fatal(err)
		}
		state, err := os.ReadFile(filepath.Join(home, "state", "amika", "ssh-hosts.json"))
		if err != nil {
			t.Fatal(err)
		}
		return string(conf), string(state)
	}

	if out, err := runRootCommandOutput(t, "secret", "ssh-key", "push",
		"--name", "laptop", "--from-file", keyPath+".pub"); err != nil {
		t.Fatalf("first push failed: %v\n%s", err, out)
	}
	firstConf, firstState := read()

	if out, err := runRootCommandOutput(t, "secret", "ssh-key", "push",
		"--name", "laptop", "--from-file", keyPath+".pub"); err != nil {
		t.Fatalf("second push failed: %v\n%s", err, out)
	}
	secondConf, secondState := read()

	if firstConf != secondConf {
		t.Errorf("amika.conf changed on a repeat push:\n--- first ---\n%s\n--- second ---\n%s",
			firstConf, secondConf)
	}
	if firstState != secondState {
		t.Errorf("ssh-hosts.json changed on a repeat push:\n--- first ---\n%s\n--- second ---\n%s",
			firstState, secondState)
	}
}

// An adopted entry is the machine's answer to "which private key", so a push
// that is not adopting one has no use for the private half at all. Before this
// rule the resolution ran first and its failure suppressed the write.
func TestSSHKeyPushInProcess_LaterPushNeedsNoPrivateKey(t *testing.T) {
	home := isolateSSHHome(t)
	keyPath := writeTestKeypair(t, filepath.Join(home, ".ssh"))
	orphan, _ := writeTestPubKey(t, t.TempDir(), "elsewhere@host")

	setupInProcessSSHKeyAPI(t, &sshKeyAPI{})

	if out, err := runRootCommandOutput(t, "secret", "ssh-key", "push",
		"--name", "laptop", "--from-file", keyPath+".pub"); err != nil {
		t.Fatalf("first push failed: %v\n%s", err, out)
	}
	out, err := runRootCommandOutput(t, "secret", "ssh-key", "push",
		"--name", "remote", "--from-file", orphan)
	if err != nil {
		t.Fatalf("push of a key with no private half failed: %v\n%s", err, out)
	}

	// Reported as unchanged, not as skipped: nothing was missing, because
	// nothing was needed.
	if !strings.Contains(out, "unchanged") {
		t.Errorf("output should report the entry unchanged: %s", out)
	}
}

func TestSSHKeyPushInProcess_UploadsWithoutRegisteringWhenPrivateKeyIsMissing(t *testing.T) {
	home := isolateSSHHome(t)
	// A .pub with no private half beside it: a legitimate thing to push (the
	// private key may live on another machine), and nothing a usable local
	// config can be written from.
	pubPath, canonical := writeTestPubKey(t, t.TempDir(), "me@host")

	api := &sshKeyAPI{}
	setupInProcessSSHKeyAPI(t, api)

	out, err := runRootCommandOutput(t, "secret", "ssh-key", "push",
		"--name", "laptop", "--from-file", pubPath)
	if err != nil {
		t.Fatalf("push failed: %v\n%s", err, out)
	}
	// The upload is the command's job and must still happen.
	if len(api.created) != 1 || api.created[0]["public_key"] != canonical {
		t.Errorf("expected the key to be uploaded, got %+v", api.created)
	}
	if !strings.Contains(out, "Left the managed SSH host entry alone") {
		t.Errorf("output should say the entry was skipped, and why: %s", out)
	}
	// No half-written config selecting a key OpenSSH cannot use.
	for _, name := range []string{"amika.conf", "config"} {
		if _, statErr := os.Stat(filepath.Join(home, ".ssh", name)); statErr == nil {
			t.Errorf("~/.ssh/%s was written for a key with no private half", name)
		}
	}
}

func TestSSHKeyPushInProcess_DoesNotRegisterWhenUploadRefused(t *testing.T) {
	home := isolateSSHHome(t)
	keyPath := writeTestKeypair(t, filepath.Join(home, ".ssh"))

	// A different key already stored under this name, so the upload is
	// refused without --force.
	api := &sshKeyAPI{existing: []map[string]string{
		{"id": "specsec_old", "name": "laptop",
			"public_key": "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIabcdefghijkl", "scope": "user"},
	}}
	setupInProcessSSHKeyAPI(t, api)

	_, err := runRootCommandOutput(t, "secret", "ssh-key", "push",
		"--name", "laptop", "--from-file", keyPath+".pub")
	if err == nil {
		t.Fatal("expected the upload to be refused")
	}

	// Same rule as `ssh-keygen`: the config must not end up pointing at a
	// private key whose public half was never stored.
	for _, name := range []string{"amika.conf", "config"} {
		if _, statErr := os.Stat(filepath.Join(home, ".ssh", name)); statErr == nil {
			t.Errorf("~/.ssh/%s was written despite the upload being refused", name)
		}
	}
}

func TestSSHKeygenInProcess_DoesNotPersistSessionWhenUploadRefused(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)

	// A key already stored under this name, with different material, so the
	// upload is refused without --force.
	api := &sshKeyAPI{existing: []map[string]string{
		{"id": "specsec_old", "name": "default",
			"public_key": "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIabcdefghijkl", "scope": "user"},
	}}
	setupInProcessSSHKeyAPI(t, api)

	_, err := runRootCommandOutput(t, "secret", "ssh-keygen")
	if err == nil {
		t.Fatal("expected the upload to be refused")
	}
	if !strings.Contains(err.Error(), "already exists with different key material") {
		t.Fatalf("unexpected error: %v", err)
	}

	// The SSH config must not have been touched: leaving it pointing at a
	// private key whose public half was never uploaded would silently break
	// every later connection.
	for _, name := range []string{"amika.conf", "config"} {
		if _, statErr := os.Stat(filepath.Join(home, ".ssh", name)); statErr == nil {
			t.Errorf("~/.ssh/%s was written despite the upload being refused", name)
		}
	}
}

func TestSSHKeygenInProcess_DoesNotUploadWhenSessionConfigIsInvalid(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)

	// An --import path containing whitespace is a perfectly valid file but a
	// config `ConfigureSession` refuses, because OpenSSH cannot express it.
	dir := filepath.Join(home, "keys with spaces")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	keyPath := filepath.Join(dir, "id_ed25519")
	if out, err := exec.Command("ssh-keygen", "-t", "ed25519", "-N", "", "-C", "imported",
		"-f", keyPath).CombinedOutput(); err != nil {
		t.Fatalf("ssh-keygen: %v\n%s", err, out)
	}

	// A different key is already stored under this name, so --force would
	// replace it. If validation ran after the upload, the remote key would be
	// gone while the local config still selected the old identity.
	api := &sshKeyAPI{existing: []map[string]string{
		{"id": "specsec_old", "name": "default",
			"public_key": "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIabcdefghijkl", "scope": "user"},
	}}
	setupInProcessSSHKeyAPI(t, api)

	_, err := runRootCommandOutput(t, "secret", "ssh-keygen",
		"--import", keyPath+".pub", "--force")
	if err == nil {
		t.Fatal("expected the invalid session config to be rejected")
	}
	// The whole point: nothing may have been uploaded.
	if len(api.created) != 0 {
		t.Errorf("the remote key was replaced despite an unusable local config: %+v", api.created)
	}
}

func TestSSHCommandsAreNotHidden(t *testing.T) {
	// Every SSH command a person is meant to run should show up in help.
	var secret *cobra.Command
	for _, c := range rootCmd.Commands() {
		if c.Name() == "secret" {
			secret = c
		}
	}
	if secret == nil {
		t.Fatal("secret command missing")
	}
	// One tree, reached through a real cobra alias, so the two spellings
	// cannot drift in visibility or contents.
	if !slices.Contains(secret.Aliases, "secrets") {
		t.Errorf("secret should alias secrets, got %v", secret.Aliases)
	}
	if secret.Hidden {
		t.Error("secret is hidden")
	}
	for _, name := range []string{"ssh-keygen", "ssh-key"} {
		var found *cobra.Command
		for _, c := range secret.Commands() {
			if c.Name() == name {
				found = c
			}
		}
		if found == nil {
			t.Errorf("secret %s is missing", name)
			continue
		}
		if found.Hidden {
			t.Errorf("secret %s is hidden", name)
		}
		for _, sub := range found.Commands() {
			if sub.Hidden {
				t.Errorf("secret %s %s is hidden", name, sub.Name())
			}
		}
	}
}

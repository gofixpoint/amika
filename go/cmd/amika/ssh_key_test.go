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
	"strings"
	"sync"
	"testing"
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
			api.mu.Unlock()
			w.WriteHeader(http.StatusCreated)
			json.NewEncoder(w).Encode(map[string]string{
				"id":         "specsec_new",
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
	if !strings.Contains(string(out), "already exists; pass --force") {
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
	var got struct {
		Status string `json:"status"`
		ID     string `json:"id"`
		Name   string `json:"name"`
		Scope  string `json:"scope"`
	}
	if err := json.Unmarshal(out, &got); err != nil {
		t.Fatalf("output is not JSON: %v\n%s", err, out)
	}
	if got.Status != "updated" || got.Name != "laptop" || got.Scope != "user" {
		t.Errorf("unexpected JSON: %+v", got)
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

	cmd := exec.Command(bin, "secret", "ssh-key", "delete", "specsec_1")
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

	cmd := exec.Command(bin, "secret", "ssh-key", "rm", "specsec_1", "-o", "json")
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

	cmd := exec.Command(bin, "secret", "ssh-key", "delete", "specsec_missing")
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

	out, err := runRootCommandOutput(t, "secret", "ssh-key", "delete", "specsec_1")
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

	out, err := runRootCommandOutput(t, "secret", "ssh-key", "rm", "specsec_1", "-o", "json")
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

	_, err := runRootCommandOutput(t, "secret", "ssh-key", "delete", "specsec_missing")
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
	if !strings.Contains(err.Error(), "already exists; pass --force") {
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

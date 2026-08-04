package sshd

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"encoding/pem"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/gofixpoint/amika/go/internal/amikad/state"
	"golang.org/x/crypto/ssh"
)

type fakeKeyGenerator struct{ calls int }

func (g *fakeKeyGenerator) Generate(_ context.Context) (GeneratedHostKey, error) {
	g.calls++
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return GeneratedHostKey{}, err
	}
	privateBlock, err := ssh.MarshalPrivateKey(private, "amikad test host key")
	if err != nil {
		return GeneratedHostKey{}, err
	}
	publicKey, err := ssh.NewPublicKey(public)
	if err != nil {
		return GeneratedHostKey{}, err
	}
	return GeneratedHostKey{
		Private: pem.EncodeToMemory(privateBlock),
		Public:  ssh.MarshalAuthorizedKey(publicKey),
	}, nil
}

type fakeProcessRunner struct {
	name string
	args []string
}

func (r *fakeProcessRunner) Run(_ context.Context, name string, args ...string) error {
	r.name = name
	r.args = append([]string(nil), args...)
	return nil
}

func testManager(t *testing.T) (*Manager, Paths, *fakeKeyGenerator, *fakeProcessRunner) {
	t.Helper()
	directory := t.TempDir()
	paths := Paths{
		Config:            filepath.Join(directory, "state", "sshd_config"),
		HostPrivateKey:    filepath.Join(directory, "state", "ssh_host_ed25519_key"),
		HostPublicKey:     filepath.Join(directory, "state", "ssh_host_ed25519_key.pub"),
		AuthorizedKeys:    filepath.Join(directory, "home", ".ssh", "authorized_keys"),
		PID:               filepath.Join(directory, "state", "sshd.pid"),
		RuntimeDirectory:  filepath.Join(directory, "run", "sshd"),
		AuthorizedKeysUID: os.Getuid(),
		AuthorizedKeysGID: os.Getgid(),
	}
	if err := os.MkdirAll(filepath.Dir(paths.AuthorizedKeys), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(filepath.Dir(paths.AuthorizedKeys), 0o700); err != nil {
		t.Fatal(err)
	}
	files := state.OSFiles{}
	store := state.NewStore(filepath.Join(directory, "injected-paths.json"), files)
	keygen := &fakeKeyGenerator{}
	processes := &fakeProcessRunner{}
	return NewManager(paths, store, files, keygen, processes), paths, keygen, processes
}

func TestSetupRejectsSymlinkedAuthorizedKeysDirectoryWithoutChangingTarget(t *testing.T) {
	manager, paths, _, _ := testManager(t)
	directory := filepath.Dir(paths.AuthorizedKeys)
	if err := os.Remove(directory); err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(t.TempDir(), "target")
	if err := os.Mkdir(target, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, directory); err != nil {
		t.Fatal(err)
	}

	if err := manager.Setup(context.Background(), SetupOptions{}); !errors.Is(err, state.ErrSymlinkPath) {
		t.Fatalf("Setup error = %v, want ErrSymlinkPath", err)
	}
	info, err := os.Stat(target)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o755 {
		t.Fatalf("symlink target mode = %o, want unchanged 755", info.Mode().Perm())
	}
}

func TestSetupCreatesLoopbackPolicyAndIsIdempotent(t *testing.T) {
	manager, paths, keygen, _ := testManager(t)
	if err := manager.Setup(context.Background(), SetupOptions{}); err != nil {
		t.Fatalf("Setup: %v", err)
	}
	if err := manager.Setup(context.Background(), SetupOptions{}); err != nil {
		t.Fatalf("idempotent Setup: %v", err)
	}
	if keygen.calls != 1 {
		t.Fatalf("keygen calls = %d, want 1", keygen.calls)
	}
	config, err := os.ReadFile(paths.Config)
	if err != nil {
		t.Fatalf("read config: %v", err)
	}
	for _, directive := range []string{
		"ListenAddress 127.0.0.1",
		"AuthenticationMethods publickey",
		"PasswordAuthentication no",
		"KbdInteractiveAuthentication no",
		"PermitRootLogin no",
		"AllowAgentForwarding no",
		"AllowTcpForwarding local",
		"GatewayPorts no",
		"X11Forwarding no",
		"PermitTunnel no",
	} {
		if !strings.Contains(string(config), directive+"\n") {
			t.Fatalf("config missing %q:\n%s", directive, config)
		}
	}
	privateInfo, err := os.Stat(paths.HostPrivateKey)
	if err != nil {
		t.Fatalf("stat private key: %v", err)
	}
	if privateInfo.Mode().Perm() != 0o600 {
		t.Fatalf("private key mode = %o, want 600", privateInfo.Mode().Perm())
	}
	runtimeInfo, err := os.Stat(paths.RuntimeDirectory)
	if err != nil {
		t.Fatalf("stat runtime directory: %v", err)
	}
	if runtimeInfo.Mode().Perm() != 0o755 {
		t.Fatalf("runtime directory mode = %o, want 755", runtimeInfo.Mode().Perm())
	}
	manifestPath := filepath.Join(filepath.Dir(filepath.Dir(paths.Config)), "injected-paths.json")
	manifestBytes, err := os.ReadFile(manifestPath)
	if err != nil {
		t.Fatal(err)
	}
	var manifest []string
	if err := json.Unmarshal(manifestBytes, &manifest); err != nil {
		t.Fatal(err)
	}
	for _, path := range manifest {
		if strings.Contains(path, ".amikad-keygen-") {
			t.Fatalf("temporary host key escaped into scrub manifest: %q", path)
		}
	}
}

func TestSetupRefusesExistingUserConfigurationUnlessForced(t *testing.T) {
	manager, paths, _, _ := testManager(t)
	if err := os.MkdirAll(filepath.Dir(paths.Config), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(paths.Config, []byte("user-defined\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := manager.Setup(context.Background(), SetupOptions{}); !errors.Is(err, ErrExistingConfiguration) {
		t.Fatalf("Setup error = %v, want ErrExistingConfiguration", err)
	}
	if err := manager.Setup(context.Background(), SetupOptions{ForceOverwrite: true}); err != nil {
		t.Fatalf("forced Setup: %v", err)
	}
	config, _ := os.ReadFile(paths.Config)
	if string(config) != RenderConfig(paths) {
		t.Fatalf("forced config = %q, want managed policy", config)
	}
}

func TestSetupRefusesInvalidExistingHostKeyUnlessForced(t *testing.T) {
	manager, paths, keygen, _ := testManager(t)
	if err := os.MkdirAll(filepath.Dir(paths.HostPrivateKey), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(paths.Config, []byte(RenderConfig(paths)), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(paths.HostPrivateKey, []byte("invalid"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(paths.HostPublicKey, []byte("invalid"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := manager.Setup(context.Background(), SetupOptions{}); !errors.Is(err, ErrExistingConfiguration) {
		t.Fatalf("Setup error = %v, want ErrExistingConfiguration", err)
	}
	if err := manager.Setup(context.Background(), SetupOptions{ForceOverwrite: true}); err != nil {
		t.Fatalf("forced Setup: %v", err)
	}
	if keygen.calls != 1 {
		t.Fatalf("keygen calls = %d, want 1", keygen.calls)
	}
}

func TestAuthorizedKeysRejectsOptionsAndWritesCanonicalKeys(t *testing.T) {
	manager, paths, _, _ := testManager(t)
	key := newTestAuthorizedKey(t)
	optionBearing := "command=\"touch /tmp/pwned\" " + key
	if err := manager.SetAuthorizedKeys(context.Background(), strings.NewReader(optionBearing)); !errors.Is(err, ErrInvalidPublicKey) {
		t.Fatalf("option-bearing key error = %v, want ErrInvalidPublicKey", err)
	}
	input := key + " comment\n" + key + " duplicate\n"
	if err := manager.SetAuthorizedKeys(context.Background(), strings.NewReader(input)); err != nil {
		t.Fatalf("SetAuthorizedKeys: %v", err)
	}
	got, err := os.ReadFile(paths.AuthorizedKeys)
	if err != nil {
		t.Fatalf("read authorized keys: %v", err)
	}
	want := key + "\n"
	if string(got) != want {
		t.Fatalf("authorized keys = %q, want %q", got, want)
	}
}

func newTestAuthorizedKey(t *testing.T) string {
	t.Helper()
	public, _, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	key, err := ssh.NewPublicKey(public)
	if err != nil {
		t.Fatal(err)
	}
	return strings.TrimSpace(string(ssh.MarshalAuthorizedKey(key)))
}

func TestShowHostKeyAndServeUseOnlyPublicManagedState(t *testing.T) {
	manager, _, _, processes := testManager(t)
	if err := manager.Setup(context.Background(), SetupOptions{}); err != nil {
		t.Fatalf("Setup: %v", err)
	}
	var output strings.Builder
	if err := manager.ShowHostKey(context.Background(), &output); err != nil {
		t.Fatalf("ShowHostKey: %v", err)
	}
	if !strings.HasPrefix(output.String(), "ssh-ed25519 ") || strings.Contains(output.String(), "PRIVATE") {
		t.Fatalf("unsafe host-key output %q", output.String())
	}
	if err := manager.Serve(context.Background()); err != nil {
		t.Fatalf("Serve: %v", err)
	}
	if processes.name != "sshd" || strings.Join(processes.args, " ") != "-D -e -f "+manager.paths.Config {
		t.Fatalf("process = %q %#v", processes.name, processes.args)
	}
}

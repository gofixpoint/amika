package ssh

import (
	"bytes"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gofixpoint/amika/go/internal/basedir"
	"github.com/gofixpoint/amika/go/internal/config"
	"github.com/gofixpoint/amika/go/internal/wslbridge"
	"golang.org/x/crypto/ssh/agent"
)

func TestEnsureAgentStartsDedicatedAgentWithOnlyAmikaIdentity(t *testing.T) {
	dir := t.TempDir()
	identity := filepath.Join(dir, "amika_id_ed25519")
	if _, err := GenerateIdentity(identity); err != nil {
		t.Fatal(err)
	}
	_, expectedPublicBlob, err := readAgentPrivateKey(identity)
	if err != nil {
		t.Fatal(err)
	}
	foreignIdentity := filepath.Join(dir, "foreign_id_ed25519")
	if _, err := GenerateIdentity(foreignIdentity); err != nil {
		t.Fatal(err)
	}
	foreignPrivateKey, _, err := readAgentPrivateKey(foreignIdentity)
	if err != nil {
		t.Fatal(err)
	}
	socket := filepath.Join(dir, "amika_agent.sock")

	originalStartAgent := startAgent
	t.Cleanup(func() { startAgent = originalStartAgent })
	var listener net.Listener
	startAgent = func(socketPath string) error {
		var err error
		listener, err = net.Listen("unix", socketPath)
		if err != nil {
			return err
		}
		t.Cleanup(func() { _ = listener.Close() })
		keyring := agent.NewKeyring()
		if err := keyring.Add(agent.AddedKey{PrivateKey: foreignPrivateKey}); err != nil {
			return err
		}
		go func() {
			for {
				connection, acceptErr := listener.Accept()
				if acceptErr != nil {
					return
				}
				go func() { _ = agent.ServeAgent(keyring, connection) }()
			}
		}()
		return nil
	}

	// The ordinary SSH_AUTH_SOCK is deliberately irrelevant: EnsureAgent
	// talks only to the explicit Amika socket.
	t.Setenv("SSH_AUTH_SOCK", filepath.Join(dir, "ordinary-agent.sock"))
	if err := EnsureAgent(socket, identity); err != nil {
		t.Fatalf("EnsureAgent: %v", err)
	}
	client, connection, err := connectAgent(socket)
	if err != nil {
		t.Fatal(err)
	}
	defer connection.Close()
	keys, err := client.List()
	if err != nil {
		t.Fatal(err)
	}
	if len(keys) != 1 {
		t.Fatalf("agent has %d identities, want exactly the Amika identity", len(keys))
	}
	if !bytes.Equal(keys[0].Blob, expectedPublicBlob) {
		t.Fatal("dedicated agent retained a non-Amika identity")
	}
}

func TestPrepareAgentSocketRefusesNonSocket(t *testing.T) {
	path := filepath.Join(t.TempDir(), "amika_agent.sock")
	if err := os.WriteFile(path, []byte("keep me"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := prepareAgentSocket(path); err == nil {
		t.Fatal("expected non-socket path to be refused")
	}
	data, err := os.ReadFile(path)
	if err != nil || string(data) != "keep me" {
		t.Fatalf("non-socket path was modified: data=%q err=%v", data, err)
	}
}

func TestConcurrentSessionChangesLeaveExactlyThePersistedIdentity(t *testing.T) {
	paths := testPaths(t)
	t.Setenv(config.EnvAPIURL, "http://localhost:3011")
	testBinary(t, "amika")
	dir := t.TempDir()
	identities := []string{
		filepath.Join(dir, "first_ed25519"),
		filepath.Join(dir, "second_ed25519"),
	}
	for _, identity := range identities {
		if _, err := GenerateIdentity(identity); err != nil {
			t.Fatal(err)
		}
	}
	foreignIdentity := filepath.Join(dir, "foreign_ed25519")
	if _, err := GenerateIdentity(foreignIdentity); err != nil {
		t.Fatal(err)
	}
	foreignPrivateKey, _, err := readAgentPrivateKey(foreignIdentity)
	if err != nil {
		t.Fatal(err)
	}
	keyring := agent.NewKeyring()
	if err := keyring.Add(agent.AddedKey{PrivateKey: foreignPrivateKey}); err != nil {
		t.Fatal(err)
	}
	extendedKeyring, ok := keyring.(agent.ExtendedAgent)
	if !ok {
		t.Fatal("test keyring does not implement ExtendedAgent")
	}
	tracked := &mutationTrackingAgent{ExtendedAgent: extendedKeyring}
	socket := filepath.Join(dir, "amika_agent.sock")
	serveTestAgent(t, socket, tracked)

	start := make(chan struct{})
	errors := make(chan error, len(identities))
	for _, identity := range identities {
		identity := identity
		go func() {
			<-start
			errors <- ConfigureSession(paths, SessionConfig{
				IdentityFile:   identity,
				KnownHostsFile: filepath.Join(dir, "known_hosts"),
				AgentSocket:    socket,
			})
		}()
	}
	close(start)
	for range identities {
		if err := <-errors; err != nil {
			t.Fatalf("ConfigureSession: %v", err)
		}
	}
	if tracked.sawInterleavedMutation() {
		t.Fatal("agent reconciliation operations interleaved")
	}

	state, err := LoadState(paths)
	if err != nil {
		t.Fatal(err)
	}
	_, persistedBlob, err := readAgentPrivateKey(state.SessionConfig.IdentityFile)
	if err != nil {
		t.Fatal(err)
	}
	client, connection, err := connectAgent(socket)
	if err != nil {
		t.Fatal(err)
	}
	defer connection.Close()
	keys, err := client.List()
	if err != nil {
		t.Fatal(err)
	}
	if len(keys) != 1 || !bytes.Equal(keys[0].Blob, persistedBlob) {
		t.Fatalf("agent identities do not match persisted session: keys=%d", len(keys))
	}
}

func TestPrepareProxyRestartsMissingAgentFromPersistedState(t *testing.T) {
	paths := testPaths(t)
	dir := t.TempDir()
	identity := filepath.Join(dir, "amika_id_ed25519")
	if _, err := GenerateIdentity(identity); err != nil {
		t.Fatal(err)
	}
	_, expectedBlob, err := readAgentPrivateKey(identity)
	if err != nil {
		t.Fatal(err)
	}
	socket := filepath.Join(dir, "missing_agent.sock")
	state := HostsState{
		SessionConfig: &SessionConfig{
			IdentityFile:   identity,
			KnownHostsFile: filepath.Join(dir, "known_hosts"),
			AgentSocket:    socket,
		},
		SSHConfigVersion: currentSSHConfigVersion,
	}
	if err := SaveState(paths, state); err != nil {
		t.Fatal(err)
	}

	originalStartAgent := startAgent
	t.Cleanup(func() { startAgent = originalStartAgent })
	startAgent = func(socketPath string) error {
		serveTestAgent(t, socketPath, agent.NewKeyring())
		return nil
	}
	if _, err := PrepareProxy(paths, os.Stderr); err != nil {
		t.Fatalf("PrepareProxy: %v", err)
	}
	client, connection, err := connectAgent(socket)
	if err != nil {
		t.Fatal(err)
	}
	defer connection.Close()
	keys, err := client.List()
	if err != nil {
		t.Fatal(err)
	}
	if len(keys) != 1 || !bytes.Equal(keys[0].Blob, expectedBlob) {
		t.Fatalf("restarted agent has the wrong identities: keys=%d", len(keys))
	}
}

func TestPrepareProxyMigratesLegacyConfigAndRequiresReconnect(t *testing.T) {
	paths := testPaths(t)
	t.Setenv(config.EnvAPIURL, "http://localhost:3011")
	testBinary(t, "amika")
	dir := t.TempDir()
	identity := filepath.Join(dir, "amika_id_ed25519")
	if _, err := GenerateIdentity(identity); err != nil {
		t.Fatal(err)
	}
	state := HostsState{
		SessionConfig: &SessionConfig{
			IdentityFile:   identity,
			KnownHostsFile: filepath.Join(dir, "known_hosts"),
		},
		SessionProxyCommands: map[string]string{
			"localhost-3011": "/usr/local/bin/amika plumbing ssh-stdio-proxy %h",
		},
	}
	if err := SaveState(paths, state); err != nil {
		t.Fatal(err)
	}
	if err := WriteAmikaConfig(paths, state); err != nil {
		t.Fatal(err)
	}
	winSSH := filepath.Join(t.TempDir(), "winssh")
	previousIsWSL, previousResolve, previousIcacls := isWSL, resolveWSLTarget, runIcacls
	isWSL = func() bool { return true }
	resolveWSLTarget = func() (wslbridge.Target, error) {
		return windowsTestTarget(winSSH), nil
	}
	runIcacls = func(string, string) error { return nil }
	t.Cleanup(func() {
		isWSL, resolveWSLTarget, runIcacls = previousIsWSL, previousResolve, previousIcacls
	})

	originalStartAgent := startAgent
	t.Cleanup(func() { startAgent = originalStartAgent })
	startAgent = func(socketPath string) error {
		serveTestAgent(t, socketPath, agent.NewKeyring())
		return nil
	}
	if _, err := PrepareProxy(paths, os.Stderr); err == nil || !strings.Contains(err.Error(), "reconnect") {
		t.Fatalf("PrepareProxy error = %v, want reconnect instruction", err)
	}

	migrated, err := LoadState(paths)
	if err != nil {
		t.Fatal(err)
	}
	expectedSocket, _ := paths.SSHAgentSocketFile()
	if migrated.SessionConfig.AgentSocket != expectedSocket {
		t.Fatalf("migrated socket = %q, want %q", migrated.SessionConfig.AgentSocket, expectedSocket)
	}
	configPath, _ := paths.SSHAmikaConfigFile()
	configData, err := os.ReadFile(configPath)
	if err != nil {
		t.Fatal(err)
	}
	for _, expected := range []string{
		"IdentityAgent " + expectedSocket,
		"ForwardAgent yes",
	} {
		if !strings.Contains(string(configData), expected) {
			t.Errorf("migrated config missing %q:\n%s", expected, configData)
		}
	}
	windowsConfig, err := os.ReadFile(filepath.Join(winSSH, basedir.SSHAmikaConfigName()))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(windowsConfig), "ForwardAgent no") {
		t.Fatalf("migrated Windows config can inherit ambient forwarding:\n%s", windowsConfig)
	}
	if _, err := PrepareProxy(paths, os.Stderr); err != nil {
		t.Fatalf("second PrepareProxy: %v", err)
	}
}

func TestPrepareProxyRetriesMigrationAfterIncludeFailure(t *testing.T) {
	paths := testPaths(t)
	t.Setenv(config.EnvAPIURL, "http://localhost:3011")
	testBinary(t, "amika")
	dir := t.TempDir()
	identity := filepath.Join(dir, "amika_id_ed25519")
	if _, err := GenerateIdentity(identity); err != nil {
		t.Fatal(err)
	}
	state := HostsState{
		SessionConfig: &SessionConfig{
			IdentityFile:   identity,
			KnownHostsFile: filepath.Join(dir, "known_hosts"),
		},
		SessionProxyCommands: map[string]string{
			"localhost-3011": "/usr/local/bin/amika plumbing ssh-stdio-proxy %h",
		},
	}
	if err := SaveState(paths, state); err != nil {
		t.Fatal(err)
	}
	configPath, _ := paths.SSHConfigFile()
	if err := os.MkdirAll(configPath, 0o700); err != nil {
		t.Fatal(err)
	}

	originalStartAgent := startAgent
	t.Cleanup(func() { startAgent = originalStartAgent })
	startAgent = func(socketPath string) error {
		serveTestAgent(t, socketPath, agent.NewKeyring())
		return nil
	}
	if _, err := PrepareProxy(paths, os.Stderr); err == nil {
		t.Fatal("PrepareProxy succeeded despite unusable primary config path")
	}
	loaded, err := LoadState(paths)
	if err != nil {
		t.Fatal(err)
	}
	if loaded.SSHConfigVersion != 0 {
		t.Fatalf("migration was marked complete after a failed artifact write: version=%d", loaded.SSHConfigVersion)
	}
}

type mutationTrackingAgent struct {
	agent.ExtendedAgent
	mu           sync.Mutex
	removeActive bool
	interleaved  bool
}

func (a *mutationTrackingAgent) RemoveAll() error {
	a.mu.Lock()
	if a.removeActive {
		a.interleaved = true
	}
	a.removeActive = true
	a.mu.Unlock()
	// Widen the protocol-operation race enough that the test reliably catches
	// callers that do not serialize the complete List/RemoveAll/Add sequence.
	time.Sleep(50 * time.Millisecond)
	return a.ExtendedAgent.RemoveAll()
}

func (a *mutationTrackingAgent) Add(key agent.AddedKey) error {
	err := a.ExtendedAgent.Add(key)
	a.mu.Lock()
	a.removeActive = false
	a.mu.Unlock()
	return err
}

func (a *mutationTrackingAgent) sawInterleavedMutation() bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.interleaved
}

func serveTestAgent(t *testing.T, socket string, keyring agent.Agent) {
	t.Helper()
	listener, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = listener.Close() })
	go func() {
		for {
			connection, acceptErr := listener.Accept()
			if acceptErr != nil {
				return
			}
			go func() { _ = agent.ServeAgent(keyring, connection) }()
		}
	}()
}

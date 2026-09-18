package ssh

import (
	"bytes"
	"net"
	"os"
	"path/filepath"
	"testing"

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

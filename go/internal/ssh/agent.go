package ssh

import (
	"bytes"
	"errors"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	cryptossh "golang.org/x/crypto/ssh"
	"golang.org/x/crypto/ssh/agent"
)

// EnsureAgent starts or repairs the dedicated Amika ssh-agent and leaves
// exactly identityFile loaded in it. It never reads or modifies the caller's
// SSH_AUTH_SOCK agent.
func EnsureAgent(socketPath, identityFile string) error {
	privateKey, publicBlob, err := readAgentPrivateKey(identityFile)
	if err != nil {
		return err
	}

	client, connection, err := connectAgent(socketPath)
	if err == nil {
		defer connection.Close()
		return loadOnlyIdentity(client, privateKey, publicBlob)
	}
	if err := prepareAgentSocket(socketPath); err != nil {
		return err
	}
	if err := startAgent(socketPath); err != nil {
		// Another simultaneous CLI invocation may have won the race to bind
		// the socket. Prefer that healthy agent over a startup error.
		client, connection, connectErr := connectAgent(socketPath)
		if connectErr != nil {
			return err
		}
		defer connection.Close()
		return loadOnlyIdentity(client, privateKey, publicBlob)
	}
	client, connection, err = connectAgent(socketPath)
	if err != nil {
		return fmt.Errorf("connect to dedicated Amika ssh-agent: %w", err)
	}
	defer connection.Close()
	return loadOnlyIdentity(client, privateKey, publicBlob)
}

// startAgent is a seam for tests that need to model daemon startup without
// leaving a real ssh-agent process behind.
var startAgent = func(socketPath string) error {
	command := exec.Command("ssh-agent", "-a", socketPath, "-s")
	if output, err := command.CombinedOutput(); err != nil {
		return fmt.Errorf("start dedicated Amika ssh-agent: %w: %s", err, strings.TrimSpace(string(output)))
	}
	return nil
}

func readAgentPrivateKey(identityFile string) (any, []byte, error) {
	data, err := os.ReadFile(identityFile)
	if err != nil {
		return nil, nil, fmt.Errorf("read Amika SSH identity: %w", err)
	}
	privateKey, err := cryptossh.ParseRawPrivateKey(data)
	if err != nil {
		return nil, nil, fmt.Errorf("read Amika SSH identity: %w", err)
	}
	signer, err := cryptossh.NewSignerFromKey(privateKey)
	if err != nil {
		return nil, nil, fmt.Errorf("read Amika SSH identity: %w", err)
	}
	return privateKey, signer.PublicKey().Marshal(), nil
}

func connectAgent(socketPath string) (agent.ExtendedAgent, net.Conn, error) {
	connection, err := net.Dial("unix", socketPath)
	if err != nil {
		return nil, nil, err
	}
	return agent.NewClient(connection), connection, nil
}

func prepareAgentSocket(socketPath string) error {
	if err := os.MkdirAll(filepath.Dir(socketPath), 0o700); err != nil {
		return fmt.Errorf("create directory for dedicated Amika ssh-agent: %w", err)
	}
	info, err := os.Lstat(socketPath)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("inspect dedicated Amika ssh-agent socket: %w", err)
	}
	if info.Mode()&os.ModeSocket == 0 {
		return fmt.Errorf("refusing to replace non-socket path %s", socketPath)
	}
	if err := os.Remove(socketPath); err != nil {
		return fmt.Errorf("remove stale dedicated Amika ssh-agent socket: %w", err)
	}
	return nil
}

func loadOnlyIdentity(client agent.ExtendedAgent, privateKey any, publicBlob []byte) error {
	keys, err := client.List()
	if err != nil {
		return fmt.Errorf("list dedicated Amika ssh-agent identities: %w", err)
	}
	if len(keys) == 1 && bytes.Equal(keys[0].Blob, publicBlob) {
		return nil
	}
	if err := client.RemoveAll(); err != nil {
		return fmt.Errorf("clear dedicated Amika ssh-agent identities: %w", err)
	}
	if err := client.Add(agent.AddedKey{PrivateKey: privateKey, Comment: "Amika SSH identity"}); err != nil {
		return fmt.Errorf("add Amika SSH identity to dedicated agent: %w", err)
	}
	return nil
}

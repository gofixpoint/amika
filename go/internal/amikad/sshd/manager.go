// Package sshd owns loopback-only OpenSSH configuration and supervision.
package sshd

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/gofixpoint/amika/go/internal/amikad/state"
	"golang.org/x/crypto/ssh"
)

// ErrExistingConfiguration indicates setup would replace user-defined SSH
// state without explicit authorization.
var ErrExistingConfiguration = errors.New("existing sshd configuration requires --force-overwrite")

// ErrInvalidPublicKey indicates malformed or option-bearing authorized-key
// input.
var ErrInvalidPublicKey = errors.New("invalid SSH public key")

// Paths contains every filesystem location owned by the managed sshd.
type Paths struct {
	Config         string
	HostPrivateKey string
	HostPublicKey  string
	AuthorizedKeys string
	PID            string
}

// DefaultPaths returns the production paths owned by amikad.
func DefaultPaths() Paths {
	return Paths{
		Config:         "/var/lib/amikad/sshd_config",
		HostPrivateKey: "/var/lib/amikad/ssh_host_ed25519_key",
		HostPublicKey:  "/var/lib/amikad/ssh_host_ed25519_key.pub",
		AuthorizedKeys: "/home/amika/.ssh/authorized_keys",
		PID:            "/var/lib/amikad/sshd.pid",
	}
}

// SetupOptions controls replacement of existing non-managed state.
type SetupOptions struct {
	ForceOverwrite bool
}

// KeyGenerator creates an Ed25519 OpenSSH host keypair at privatePath and
// privatePath+".pub".
type KeyGenerator interface {
	Generate(ctx context.Context, privatePath string) error
}

// ProcessRunner runs the foreground OpenSSH daemon until ctx is cancelled or
// the process exits.
type ProcessRunner interface {
	Run(ctx context.Context, name string, args ...string) error
}

// AtomicFiles supplies the filesystem operations needed by Manager.
type AtomicFiles interface {
	ReadFile(string) ([]byte, error)
	Lstat(string) (fs.FileInfo, error)
	WriteFileAtomic(string, []byte, fs.FileMode) error
}

// Manager configures and runs one loopback-only OpenSSH daemon.
type Manager struct {
	paths     Paths
	store     state.SensitiveStore
	files     AtomicFiles
	keygen    KeyGenerator
	processes ProcessRunner
}

// NewManager creates a manager with explicit, testable boundaries.
func NewManager(
	paths Paths,
	store state.SensitiveStore,
	files AtomicFiles,
	keygen KeyGenerator,
	processes ProcessRunner,
) *Manager {
	return &Manager{paths: paths, store: store, files: files, keygen: keygen, processes: processes}
}

// Setup installs the managed policy and creates a host key only when absent.
func (m *Manager) Setup(ctx context.Context, options SetupOptions) error {
	if err := validatePaths(m.paths); err != nil {
		return err
	}
	for _, directory := range []string{
		filepath.Dir(m.paths.Config),
		filepath.Dir(m.paths.AuthorizedKeys),
	} {
		if err := os.MkdirAll(directory, 0o700); err != nil {
			return err
		}
	}

	desiredConfig := []byte(RenderConfig(m.paths))
	existingConfig, err := m.files.ReadFile(m.paths.Config)
	switch {
	case err == nil && bytes.Equal(existingConfig, desiredConfig):
	case err == nil && !options.ForceOverwrite:
		return ErrExistingConfiguration
	case err != nil && !errors.Is(err, fs.ErrNotExist):
		return err
	default:
		if err := m.files.WriteFileAtomic(m.paths.Config, desiredConfig, 0o600); err != nil {
			return err
		}
	}

	privateExists, err := pathExists(m.files, m.paths.HostPrivateKey)
	if err != nil {
		return err
	}
	publicExists, err := pathExists(m.files, m.paths.HostPublicKey)
	if err != nil {
		return err
	}
	if privateExists && publicExists && validateHostKeyPair(m.files, m.paths) {
		return nil
	}
	if (privateExists || publicExists) && !options.ForceOverwrite {
		return ErrExistingConfiguration
	}
	for _, path := range []string{m.paths.HostPrivateKey, m.paths.HostPublicKey} {
		if err := os.Remove(path); err != nil && !errors.Is(err, fs.ErrNotExist) {
			return err
		}
	}
	return m.generateHostKey(ctx)
}

// ShowHostKey writes the canonical Ed25519 public host key and no private
// material.
func (m *Manager) ShowHostKey(ctx context.Context, output io.Writer) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	contents, err := m.files.ReadFile(m.paths.HostPublicKey)
	if err != nil {
		return err
	}
	key, err := canonicalPublicKey(string(contents), map[string]bool{"ssh-ed25519": true})
	if err != nil {
		return err
	}
	_, err = io.WriteString(output, key+"\n")
	return err
}

// SetAuthorizedKeys validates and atomically replaces the complete authorized
// key set through the scrub-registered sensitive store.
func (m *Manager) SetAuthorizedKeys(ctx context.Context, input io.Reader) error {
	if err := os.MkdirAll(filepath.Dir(m.paths.AuthorizedKeys), 0o700); err != nil {
		return err
	}
	contents, err := io.ReadAll(io.LimitReader(input, (1<<20)+1))
	if err != nil {
		return err
	}
	if len(contents) > 1<<20 {
		return state.ErrSensitiveFileTooLarge
	}

	allowedTypes := map[string]bool{
		"ecdsa-sha2-nistp256":                true,
		"sk-ecdsa-sha2-nistp256@openssh.com": true,
		"sk-ssh-ed25519@openssh.com":         true,
		"ssh-ed25519":                        true,
		"ssh-rsa":                            true,
	}
	keys := make([]string, 0)
	seen := make(map[string]struct{})
	for _, line := range strings.Split(string(contents), "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		key, err := canonicalPublicKey(line, allowedTypes)
		if err != nil {
			return err
		}
		if _, duplicate := seen[key]; !duplicate {
			seen[key] = struct{}{}
			keys = append(keys, key)
		}
	}
	if len(keys) == 0 {
		return ErrInvalidPublicKey
	}
	return m.store.WriteAndRegister(
		ctx,
		m.paths.AuthorizedKeys,
		strings.NewReader(strings.Join(keys, "\n")+"\n"),
		0o600,
	)
}

// Serve runs sshd in the foreground with only the managed configuration.
func (m *Manager) Serve(ctx context.Context) error {
	return m.processes.Run(ctx, "sshd", "-D", "-e", "-f", m.paths.Config)
}

func (m *Manager) generateHostKey(ctx context.Context) error {
	temporaryDirectory, err := os.MkdirTemp(filepath.Dir(m.paths.HostPrivateKey), ".amikad-keygen-*")
	if err != nil {
		return err
	}
	defer os.RemoveAll(temporaryDirectory)
	temporaryPrivate := filepath.Join(temporaryDirectory, "host-key")
	for _, temporary := range []struct {
		path string
		mode fs.FileMode
	}{
		{path: temporaryPrivate, mode: 0o600},
		{path: temporaryPrivate + ".pub", mode: 0o644},
	} {
		if err := m.store.WriteAndRegister(ctx, temporary.path, strings.NewReader(""), temporary.mode); err != nil {
			return err
		}
		if err := os.Remove(temporary.path); err != nil {
			return err
		}
	}
	if err := m.keygen.Generate(ctx, temporaryPrivate); err != nil {
		return err
	}
	privateKey, err := os.ReadFile(temporaryPrivate)
	if err != nil {
		return err
	}
	publicKey, err := os.ReadFile(temporaryPrivate + ".pub")
	if err != nil {
		return err
	}
	if _, err := canonicalPublicKey(string(publicKey), map[string]bool{"ssh-ed25519": true}); err != nil {
		return err
	}
	if err := m.store.WriteAndRegister(ctx, m.paths.HostPrivateKey, bytes.NewReader(privateKey), 0o600); err != nil {
		return err
	}
	return m.store.WriteAndRegister(ctx, m.paths.HostPublicKey, bytes.NewReader(publicKey), 0o644)
}

func canonicalPublicKey(line string, allowedTypes map[string]bool) (string, error) {
	key, _, options, rest, err := ssh.ParseAuthorizedKey([]byte(line))
	if err != nil || len(options) != 0 || strings.TrimSpace(string(rest)) != "" || !allowedTypes[key.Type()] {
		return "", ErrInvalidPublicKey
	}
	return strings.TrimSpace(string(ssh.MarshalAuthorizedKey(key))), nil
}

func pathExists(files AtomicFiles, path string) (bool, error) {
	_, err := files.Lstat(path)
	if errors.Is(err, fs.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return true, nil
}

func validateHostKeyPair(files AtomicFiles, paths Paths) bool {
	privateInfo, err := files.Lstat(paths.HostPrivateKey)
	if err != nil || !privateInfo.Mode().IsRegular() || privateInfo.Mode().Perm() != 0o600 {
		return false
	}
	publicInfo, err := files.Lstat(paths.HostPublicKey)
	if err != nil || !publicInfo.Mode().IsRegular() || publicInfo.Mode().Perm()&0o022 != 0 {
		return false
	}
	privateBytes, err := files.ReadFile(paths.HostPrivateKey)
	if err != nil {
		return false
	}
	signer, err := ssh.ParsePrivateKey(privateBytes)
	if err != nil || signer.PublicKey().Type() != ssh.KeyAlgoED25519 {
		return false
	}
	publicBytes, err := files.ReadFile(paths.HostPublicKey)
	if err != nil {
		return false
	}
	publicKey, _, options, rest, err := ssh.ParseAuthorizedKey(publicBytes)
	if err != nil || len(options) != 0 || strings.TrimSpace(string(rest)) != "" || publicKey.Type() != ssh.KeyAlgoED25519 {
		return false
	}
	return bytes.Equal(signer.PublicKey().Marshal(), publicKey.Marshal())
}

func validatePaths(paths Paths) error {
	for _, path := range []string{
		paths.Config,
		paths.HostPrivateKey,
		paths.HostPublicKey,
		paths.AuthorizedKeys,
		paths.PID,
	} {
		if !filepath.IsAbs(path) || filepath.Clean(path) != path {
			return fmt.Errorf("invalid sshd path: %w", state.ErrInvalidPath)
		}
	}
	return nil
}

// RenderConfig returns the complete loopback-only sshd policy.
func RenderConfig(paths Paths) string {
	return fmt.Sprintf(`Port 22
ListenAddress 127.0.0.1
Protocol 2
HostKey %s
PidFile %s
AuthorizedKeysFile %s
AllowUsers amika
AuthenticationMethods publickey
PubkeyAuthentication yes
PasswordAuthentication no
KbdInteractiveAuthentication no
ChallengeResponseAuthentication no
PermitRootLogin no
PermitEmptyPasswords no
AllowAgentForwarding no
AllowTcpForwarding local
GatewayPorts no
X11Forwarding no
PermitTunnel no
PermitUserEnvironment no
UsePAM no
Subsystem sftp internal-sftp
`, paths.HostPrivateKey, paths.PID, paths.AuthorizedKeys)
}

// ExecKeyGenerator invokes the image-provided OpenSSH key generator.
type ExecKeyGenerator struct{}

// Generate creates a passwordless Ed25519 keypair.
func (ExecKeyGenerator) Generate(ctx context.Context, privatePath string) error {
	command := exec.CommandContext(ctx, "ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", privatePath)
	command.Stderr = os.Stderr
	return command.Run()
}

// ExecProcessRunner runs foreground processes with daemon output on stderr.
type ExecProcessRunner struct{}

// Run executes one process without a shell or environment interpolation.
func (ExecProcessRunner) Run(ctx context.Context, name string, args ...string) error {
	command := exec.CommandContext(ctx, name, args...)
	command.Stdout = os.Stderr
	command.Stderr = os.Stderr
	return command.Run()
}

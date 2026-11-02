// Package sshd owns loopback-only OpenSSH configuration and supervision.
package sshd

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"strconv"
	"strings"
	"unicode"

	"github.com/gofixpoint/amika/go/internal/amikad/platform"
	"github.com/gofixpoint/amika/go/internal/amikad/state"
	"github.com/gofixpoint/amika/go/internal/constants"
	"golang.org/x/crypto/ssh"
)

// ErrExistingConfiguration indicates setup would replace user-defined SSH
// state without explicit authorization.
var ErrExistingConfiguration = errors.New("existing sshd configuration requires --force-overwrite")

// ErrInvalidPublicKey indicates malformed or option-bearing authorized-key
// input.
var ErrInvalidPublicKey = errors.New("invalid SSH public key")

// ErrInvalidAllowUser indicates an account name sshd's AllowUsers would
// misparse as a pattern, list, or user@host form.
var ErrInvalidAllowUser = errors.New("invalid sshd login account name")

// Paths contains every filesystem location owned by the managed sshd, plus
// the loopback port it listens on and the one account it admits.
type Paths struct {
	Config         string
	HostPrivateKey string
	HostPublicKey  string
	AuthorizedKeys string
	PID            string
	// RuntimeDirectory is the privilege-separation directory a root sshd
	// needs, created by Setup. Empty when none must be created: the OS ships
	// it, or sshd runs unprivileged and never chroots.
	RuntimeDirectory  string
	AuthorizedKeysUID int
	AuthorizedKeysGID int
	// AllowUser is the single account sshd admits (AllowUsers).
	AllowUser string
	// Unprivileged marks a manager running as AllowUser itself rather than
	// root: it never chowns, and Setup checks the authorized-keys directory
	// against sshd's StrictModes instead.
	Unprivileged bool
	// SSHD is the absolute sshd binary path. Empty resolves it through the
	// platform when sshd starts.
	SSHD string
	// Port the managed sshd binds on 127.0.0.1. This is the single source of
	// truth for the loopback address: the rendered config listens on it and
	// the no-relay bridge dials it, so the two can never drift apart.
	Port int
}

// EnvManagedUser overrides the account whose UID/GID own the managed sshd's
// authorized_keys file, and whose home directory it lives under. Empty (the
// default) uses "amika". This is a single-user override, not multi-user
// support: everything under DefaultPaths still assumes exactly one managed
// account.
const EnvManagedUser = "AMIKA_SSHD_USER"

// DefaultPaths returns the production (root mode) paths owned by amikad, for
// the managed user named by EnvManagedUser (default "amika").
func DefaultPaths() Paths {
	username := os.Getenv(EnvManagedUser)
	if username == "" {
		username = "amika"
	}
	uid, gid := -1, -1
	if account, err := user.Lookup(username); err == nil {
		uid, _ = strconv.Atoi(account.Uid)
		gid, _ = strconv.Atoi(account.Gid)
	}
	return Paths{
		Config:            "/var/lib/amikad/sshd_config",
		HostPrivateKey:    "/var/lib/amikad/ssh_host_ed25519_key",
		HostPublicKey:     "/var/lib/amikad/ssh_host_ed25519_key.pub",
		AuthorizedKeys:    "/home/" + username + "/.ssh/authorized_keys",
		PID:               "/var/lib/amikad/sshd.pid",
		RuntimeDirectory:  platform.Current().SSHD().PrivsepDirectory,
		AuthorizedKeysUID: uid,
		AuthorizedKeysGID: gid,
		AllowUser:         username,
		Port:              constants.ManagedSSHDPort,
	}
}

// UserPaths returns the user-mode paths: every file lives directly in
// stateDirectory, including authorized_keys, so the account's own ~/.ssh is
// never read or written, and sshd runs as, and admits only, username.
func UserPaths(stateDirectory, username string, port int) Paths {
	return Paths{
		Config:            filepath.Join(stateDirectory, "sshd_config"),
		HostPrivateKey:    filepath.Join(stateDirectory, "ssh_host_ed25519_key"),
		HostPublicKey:     filepath.Join(stateDirectory, "ssh_host_ed25519_key.pub"),
		AuthorizedKeys:    filepath.Join(stateDirectory, "authorized_keys"),
		PID:               filepath.Join(stateDirectory, "sshd.pid"),
		AuthorizedKeysUID: -1,
		AuthorizedKeysGID: -1,
		AllowUser:         username,
		Unprivileged:      true,
		Port:              port,
	}
}

// SetupOptions controls replacement of existing non-managed state.
type SetupOptions struct {
	ForceOverwrite bool
}

// GeneratedHostKey holds one in-memory Ed25519 OpenSSH host keypair.
type GeneratedHostKey struct {
	Private []byte
	Public  []byte
}

// KeyGenerator creates an Ed25519 OpenSSH host keypair without staging it on
// disk. Only the final scrub-registered paths ever contain private material.
type KeyGenerator interface {
	Generate(context.Context) (GeneratedHostKey, error)
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
	platform  platform.Platform
}

// NewManager creates a manager with explicit, testable boundaries.
func NewManager(
	paths Paths,
	store state.SensitiveStore,
	files AtomicFiles,
	keygen KeyGenerator,
	processes ProcessRunner,
) *Manager {
	return &Manager{
		paths:     paths,
		store:     store,
		files:     files,
		keygen:    keygen,
		processes: processes,
		platform:  platform.Current(),
	}
}

// Setup installs the managed policy and creates a host key only when absent.
func (m *Manager) Setup(ctx context.Context, options SetupOptions) error {
	if err := validatePaths(m.paths); err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(m.paths.Config), 0o700); err != nil {
		return err
	}
	if err := m.prepareAuthorizedKeysDirectory(); err != nil {
		return err
	}
	if m.paths.Unprivileged {
		// StrictModes refuses an authorized_keys file under any directory
		// other users could write. Fail here with the reason rather than let
		// sshd silently reject every login.
		if err := m.platform.CheckStrictModesPath(filepath.Dir(m.paths.AuthorizedKeys), os.Getuid()); err != nil {
			return err
		}
	}
	if m.paths.RuntimeDirectory != "" {
		if err := os.MkdirAll(m.paths.RuntimeDirectory, 0o755); err != nil {
			return err
		}
		if err := os.Chmod(m.paths.RuntimeDirectory, 0o755); err != nil {
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
	if err := m.prepareAuthorizedKeysDirectory(); err != nil {
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
	return m.writeAuthorizedKeys(ctx, strings.Join(keys, "\n")+"\n")
}

// ClearAuthorizedKeys atomically installs an empty authorized-key set,
// authorizing no logins while keeping sshd runnable. This is the deliberate
// zero-key state: unlike SetAuthorizedKeys, which fail-closes on empty input to
// catch a caller that meant to pass keys, Clear is the explicit way to say
// "no keys". It overwrites any prior generation's keys through the same
// scrub-registered store, so a re-provisioned sandbox never inherits stale
// authorizations.
func (m *Manager) ClearAuthorizedKeys(ctx context.Context) error {
	if err := m.prepareAuthorizedKeysDirectory(); err != nil {
		return err
	}
	return m.writeAuthorizedKeys(ctx, "")
}

func (m *Manager) writeAuthorizedKeys(ctx context.Context, contents string) error {
	if m.paths.Unprivileged {
		return m.store.WriteAndRegister(ctx, m.paths.AuthorizedKeys, strings.NewReader(contents), 0o600)
	}
	return m.store.WriteAndRegisterOwned(
		ctx,
		m.paths.AuthorizedKeys,
		strings.NewReader(contents),
		0o600,
		state.Ownership{
			UID: m.paths.AuthorizedKeysUID,
			GID: m.paths.AuthorizedKeysGID,
		},
	)
}

func (m *Manager) prepareAuthorizedKeysDirectory() error {
	directory := filepath.Dir(m.paths.AuthorizedKeys)
	info, err := m.files.Lstat(directory)
	if errors.Is(err, fs.ErrNotExist) {
		return fmt.Errorf("authorized-keys directory missing: %w", state.ErrInvalidPath)
	}
	if err != nil {
		return err
	}
	if info.Mode()&fs.ModeSymlink != 0 {
		return state.ErrSymlinkPath
	}
	if !info.IsDir() || info.Mode().Perm() != 0o700 {
		return fmt.Errorf("unsafe authorized-keys directory: %w", state.ErrInvalidPath)
	}
	if m.paths.Unprivileged {
		return nil
	}
	// Lchown cannot follow a final-component symlink if the sandbox user
	// races this check. A replacement real directory can only be assigned to
	// that same unprivileged user and is never chmodded by root here.
	return os.Lchown(
		directory,
		m.paths.AuthorizedKeysUID,
		m.paths.AuthorizedKeysGID,
	)
}

// Serve runs sshd in the foreground with only the managed configuration. sshd
// is started by absolute path because it re-executes itself and refuses to
// start otherwise.
func (m *Manager) Serve(ctx context.Context) error {
	binary := m.paths.SSHD
	if binary == "" {
		resolved, err := platform.FindSSHD(m.platform)
		if err != nil {
			return err
		}
		binary = resolved
	}
	return m.processes.Run(ctx, binary, "-D", "-e", "-f", m.paths.Config)
}

// LoopbackAddress is where the managed sshd accepts connections. The no-relay
// bridge dials this rather than hardcoding a port, so the listener and the
// dial target are always the same value.
func (m *Manager) LoopbackAddress() string {
	return net.JoinHostPort("127.0.0.1", strconv.Itoa(m.paths.Port))
}

func (m *Manager) generateHostKey(ctx context.Context) error {
	generated, err := m.keygen.Generate(ctx)
	if err != nil {
		return err
	}
	if _, err := canonicalPublicKey(string(generated.Public), map[string]bool{"ssh-ed25519": true}); err != nil {
		return err
	}
	if err := m.store.WriteAndRegister(ctx, m.paths.HostPrivateKey, bytes.NewReader(generated.Private), 0o600); err != nil {
		return err
	}
	return m.store.WriteAndRegister(ctx, m.paths.HostPublicKey, bytes.NewReader(generated.Public), 0o644)
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
	required := []string{
		paths.Config,
		paths.HostPrivateKey,
		paths.HostPublicKey,
		paths.AuthorizedKeys,
		paths.PID,
	}
	if paths.RuntimeDirectory != "" {
		required = append(required, paths.RuntimeDirectory)
	}
	for _, path := range required {
		if !filepath.IsAbs(path) || filepath.Clean(path) != path {
			return fmt.Errorf("invalid sshd path: %w", state.ErrInvalidPath)
		}
	}
	if !paths.Unprivileged && (paths.AuthorizedKeysUID < 0 || paths.AuthorizedKeysGID < 0) {
		return fmt.Errorf("invalid authorized-keys owner: %w", state.ErrInvalidPath)
	}
	if err := ValidateAllowUser(paths.AllowUser); err != nil {
		return err
	}
	if paths.Port < 1 || paths.Port > 65535 {
		return fmt.Errorf("invalid sshd port %d", paths.Port)
	}
	return nil
}

// ValidateAllowUser accepts an account name sshd's AllowUsers reads as one
// literal user: no whitespace, control characters, quoting, pattern (`*?!`),
// list (`,`), or user@host (`@`) syntax, and no leading `-`.
func ValidateAllowUser(name string) error {
	if name == "" || len(name) > 256 || strings.HasPrefix(name, "-") {
		return ErrInvalidAllowUser
	}
	for _, r := range name {
		if unicode.IsSpace(r) || unicode.IsControl(r) || strings.ContainsRune(`*?!,@"'\#%`, r) {
			return ErrInvalidAllowUser
		}
	}
	return nil
}

// RenderConfig returns the complete loopback-only sshd policy.
func RenderConfig(paths Paths) string {
	return fmt.Sprintf(`Port %d
ListenAddress 127.0.0.1
Protocol 2
HostKey %s
PidFile %s
AuthorizedKeysFile %s
AllowUsers %s
AuthenticationMethods publickey
PubkeyAuthentication yes
PasswordAuthentication no
KbdInteractiveAuthentication no
ChallengeResponseAuthentication no
PermitRootLogin no
PermitEmptyPasswords no
AllowAgentForwarding yes
AllowTcpForwarding local
GatewayPorts no
X11Forwarding no
PermitTunnel no
PermitUserEnvironment no
UsePAM no
Subsystem sftp internal-sftp
`, paths.Port, paths.HostPrivateKey, paths.PID, paths.AuthorizedKeys, paths.AllowUser)
}

// Ed25519KeyGenerator creates a passwordless OpenSSH keypair in memory.
type Ed25519KeyGenerator struct{}

// Generate creates a passwordless Ed25519 keypair.
func (Ed25519KeyGenerator) Generate(ctx context.Context) (GeneratedHostKey, error) {
	if err := ctx.Err(); err != nil {
		return GeneratedHostKey{}, err
	}
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return GeneratedHostKey{}, err
	}
	privateBlock, err := ssh.MarshalPrivateKey(private, "amikad SSH host key")
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

// ExecProcessRunner runs foreground processes with daemon output on stderr.
type ExecProcessRunner struct{}

// Run executes one process without a shell or environment interpolation.
func (ExecProcessRunner) Run(ctx context.Context, name string, args ...string) error {
	resolved, err := exec.LookPath(name)
	if err != nil {
		return err
	}
	command := exec.CommandContext(ctx, resolved, args...)
	command.Stdout = os.Stderr
	command.Stderr = os.Stderr
	return command.Run()
}

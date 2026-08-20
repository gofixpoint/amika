package ssh

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/coder/websocket"
	"github.com/gofixpoint/amika/go/internal/apiclient"
	"github.com/gofixpoint/amika/go/internal/basedir"
	"github.com/gofixpoint/amika/go/internal/config"
	"github.com/gofixpoint/amika/go/internal/wsstream"
	cryptossh "golang.org/x/crypto/ssh"
)

const proxyCopyBufferBytes = 32 * 1024

// safeAliasPart matches a sandbox name, which may itself contain dots.
var safeAliasPart = regexp.MustCompile(`^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$`)

// safeAliasSegment matches exactly one dot-free alias segment, used for the
// parts an alias is split on: the sandbox id and the environment slug.
var safeAliasSegment = regexp.MustCompile(`^[A-Za-z0-9_-]+$`)

// proxyCommandSuffix is the fixed argv tail every managed ProxyCommand carries.
// Only the leading executable path may vary, so a session config read back from
// disk can never smuggle a different command into the user's SSH config.
const proxyCommandSuffix = " plumbing ssh-stdio-proxy %h"

// proxyPathUnsafeRunes must never appear in a ProxyCommand executable path.
// OpenSSH runs the line through a shell, so a metacharacter in the path would
// be executed rather than treated as part of it, and OpenSSH expands %-tokens
// in the line before running it.
const proxyPathUnsafeRunes = "%\"'`$&;|<>()[]{}*?!#~\\\r\n\t "

// ErrInvalidSessionAlias marks a host value that is not a safe v2 Amika
// alias.
var ErrInvalidSessionAlias = errors.New("invalid Amika SSH host alias")

// ErrUnsafeBinaryPath marks an amika executable path that cannot be safely
// embedded in a ProxyCommand line.
var ErrUnsafeBinaryPath = errors.New("unsafe amika executable path for ProxyCommand")

// ErrHostKeyMismatch marks a descriptor whose immutable identity does not
// match the requested host.
var ErrHostKeyMismatch = errors.New("SSH host identity mismatch")

// SandboxAlias identifies the immutable sandbox id and the control-plane
// environment parsed from a v2 host alias.
type SandboxAlias struct {
	Name        string
	ID          string
	Environment string
}

// SessionConfig describes the local key material shared by every environment's
// session block: the private key OpenSSH authenticates with and the file its
// host-key pins live in.
//
// Neither is per-environment. One private key authenticates to every control
// plane, each of which holds its own uploaded copy of the public key, so an
// identity imported while pointed at one environment stays in effect for all of
// them. Only the ProxyCommand varies per environment, and it is stored
// separately in HostsState.
type SessionConfig struct {
	IdentityFile   string
	KnownHostsFile string
}

// SessionCreator creates a fresh transport descriptor for each SSH dial.
type SessionCreator interface {
	CreateSSHSession(string) (*apiclient.SSHSession, error)
}

// Stream is the binary WebSocket abstraction used by the stdio proxy.
type Stream interface {
	io.Reader
	io.Writer
	io.Closer
}

// SessionDialer opens a binary stream with a credential sent outside argv.
type SessionDialer interface {
	Dial(context.Context, string, string) (Stream, error)
}

// HostKeyPinStore atomically creates or verifies an alias-keyed known-host pin.
// An existing different key must fail closed.
type HostKeyPinStore interface {
	Pin(string, string) error
}

// BuildSessionAlias combines a safe human name, immutable sandbox id, and the
// control-plane environment slug into a v2 host alias.
//
// The environment goes second-to-last rather than first because the sandbox
// name may itself contain dots: parsing has to pop fixed-position segments off
// the right and let the name absorb whatever remains.
func BuildSessionAlias(name, id, environment string) (string, error) {
	if name == "" || id == "" || environment == "" ||
		!safeAliasPart.MatchString(name) ||
		!safeAliasSegment.MatchString(id) ||
		!safeAliasSegment.MatchString(environment) {
		return "", ErrInvalidSessionAlias
	}
	alias := name + "." + id + "." + environment + ".amika"
	if len(alias) > 253 {
		return "", ErrInvalidSessionAlias
	}
	return alias, nil
}

// ParseSessionAlias pops the environment and sandbox id off the right so dotted
// sandbox names remain intact.
func ParseSessionAlias(alias string) (SandboxAlias, error) {
	if len(alias) > 253 || !strings.HasSuffix(alias, ".amika") || strings.ContainsAny(alias, "\r\n\t *?![]\\") {
		return SandboxAlias{}, ErrInvalidSessionAlias
	}
	rest, environment, ok := cutLastSegment(strings.TrimSuffix(alias, ".amika"))
	if !ok {
		return SandboxAlias{}, ErrInvalidSessionAlias
	}
	name, id, ok := cutLastSegment(rest)
	if !ok {
		return SandboxAlias{}, ErrInvalidSessionAlias
	}
	parsed := SandboxAlias{Name: name, ID: id, Environment: environment}
	if !safeAliasPart.MatchString(parsed.Name) ||
		!safeAliasSegment.MatchString(parsed.ID) ||
		!safeAliasSegment.MatchString(parsed.Environment) {
		return SandboxAlias{}, ErrInvalidSessionAlias
	}
	return parsed, nil
}

// cutLastSegment splits value at its final dot into the text before it and the
// segment after it, reporting false when there is no dot or either side is
// empty.
func cutLastSegment(value string) (string, string, bool) {
	separator := strings.LastIndexByte(value, '.')
	if separator <= 0 || separator == len(value)-1 {
		return "", "", false
	}
	return value[:separator], value[separator+1:], true
}

// BuildProxyCommand renders the ProxyCommand line that reaches amika through
// the given executable path.
func BuildProxyCommand(binaryPath string) (string, error) {
	if !safeProxyBinaryPath(binaryPath) {
		return "", ErrUnsafeBinaryPath
	}
	return binaryPath + proxyCommandSuffix, nil
}

// ParseProxyCommand returns the executable path from a managed ProxyCommand
// line, rejecting any line whose argv tail is not the fixed proxy invocation or
// whose path is not shell-safe.
func ParseProxyCommand(proxyCommand string) (string, error) {
	binaryPath, ok := strings.CutSuffix(proxyCommand, proxyCommandSuffix)
	if !ok || !safeProxyBinaryPath(binaryPath) {
		return "", ErrUnsafeBinaryPath
	}
	return binaryPath, nil
}

// ResolveProxyCommand builds the ProxyCommand for the amika executable the
// current process should be reached through.
func ResolveProxyCommand() (string, error) {
	binaryPath, err := config.BinaryPath()
	if err != nil {
		return "", err
	}
	return BuildProxyCommand(binaryPath)
}

// BuildWSLProxyCommand renders the ProxyCommand a Windows OpenSSH client uses
// to reach a session alias: it re-enters the owning WSL distribution and
// execs the same Linux amika binary the Linux-side proxy would. The
// distribution name and binary path are held to the alias and proxy path
// safety rules, so a corrupted mirror source can only ever produce the fixed
// proxy invocation.
func BuildWSLProxyCommand(distro, binaryPath string) (string, error) {
	if !safeAliasPart.MatchString(distro) {
		return "", fmt.Errorf("unsafe WSL distribution name %q", distro)
	}
	if !safeProxyBinaryPath(binaryPath) {
		return "", ErrUnsafeBinaryPath
	}
	return "wsl.exe -d " + distro + " -e " + binaryPath + proxyCommandSuffix, nil
}

// RenderSessionConfig renders one environment's wildcard block. The pattern is
// scoped to `*.<environment>.amika` rather than `*.amika` so each control plane
// gets its own ProxyCommand: a bare `*.amika` would also match every other
// environment's aliases, and OpenSSH takes the first value it finds for an
// option.
func RenderSessionConfig(environment, proxyCommand string, session SessionConfig) (string, error) {
	if !safeAliasSegment.MatchString(environment) ||
		!safeConfigPath(session.IdentityFile) ||
		!safeConfigPath(session.KnownHostsFile) {
		return "", ErrInvalidSessionAlias
	}
	if _, err := ParseProxyCommand(proxyCommand); err != nil {
		return "", err
	}
	return renderSessionBlock(environment, proxyCommand, session.IdentityFile, session.KnownHostsFile), nil
}

// renderSessionBlock formats one environment's wildcard session block. Path
// and command validation belongs to the callers, which apply different rules
// per target platform.
func renderSessionBlock(environment, proxyCommand, identityFile, knownHostsFile string) string {
	return fmt.Sprintf(`Host *.%s.amika
  User amika
  IdentityFile %s
  IdentitiesOnly yes
  StrictHostKeyChecking yes
  UserKnownHostsFile %s
  ProxyCommand %s
  ServerAliveInterval 15
  ServerAliveCountMax 3
`, environment, identityFile, knownHostsFile, proxyCommand)
}

// KnownHostLine returns one canonical alias-keyed Ed25519 pin.
func KnownHostLine(alias, hostPublicKey string) (string, error) {
	if _, err := ParseSessionAlias(alias); err != nil {
		return "", err
	}
	canonical, err := canonicalHostPublicKey(hostPublicKey)
	if err != nil {
		return "", err
	}
	return alias + " " + canonical + "\n", nil
}

// PrepareSessionHost fetches a descriptor and pins its key before OpenSSH is
// launched.
func PrepareSessionHost(
	creator SessionCreator,
	pins HostKeyPinStore,
	sandboxID string,
	alias string,
) (*apiclient.SSHSession, error) {
	parsed, err := ParseSessionAlias(alias)
	if err != nil || parsed.ID != sandboxID {
		return nil, ErrHostKeyMismatch
	}
	session, err := creator.CreateSSHSession(sandboxID)
	if err != nil {
		return nil, err
	}
	if err := session.Validate(sandboxID); err != nil {
		return nil, err
	}
	canonical, err := canonicalHostPublicKey(session.HostPublicKey)
	if err != nil {
		return nil, err
	}
	if err := pins.Pin(alias, canonical); err != nil {
		return nil, err
	}
	return session, nil
}

// ProxySession creates a fresh descriptor, dials it with header credentials,
// and copies opaque bytes between OpenSSH standard I/O and the WebSocket.
func ProxySession(
	ctx context.Context,
	creator SessionCreator,
	dialer SessionDialer,
	alias string,
	stdin io.Reader,
	stdout io.Writer,
) error {
	parsed, err := ParseSessionAlias(alias)
	if err != nil {
		return err
	}
	session, err := creator.CreateSSHSession(parsed.ID)
	if err != nil {
		return err
	}
	if err := session.Validate(parsed.ID); err != nil {
		return err
	}
	stream, err := dialer.Dial(ctx, session.ConnectURL, session.ConnectCredential)
	if err != nil {
		return errors.New("failed to connect direct SSH transport")
	}
	defer stream.Close()

	type result struct{ err error }
	results := make(chan result, 2)
	go func() {
		buffer := make([]byte, proxyCopyBufferBytes)
		_, copyErr := io.CopyBuffer(stream, stdin, buffer)
		results <- result{err: copyErr}
	}()
	go func() {
		buffer := make([]byte, proxyCopyBufferBytes)
		_, copyErr := io.CopyBuffer(stdout, stream, buffer)
		results <- result{err: copyErr}
	}()
	first := <-results
	_ = stream.Close()
	second := <-results
	if !expectedStreamClose(first.err) {
		return errors.New("direct SSH transport closed unexpectedly")
	}
	if !expectedStreamClose(second.err) {
		return errors.New("direct SSH transport closed unexpectedly")
	}
	return nil
}

func expectedStreamClose(err error) bool {
	if err == nil || errors.Is(err, io.EOF) || errors.Is(err, context.Canceled) {
		return true
	}
	status := websocket.CloseStatus(err)
	return status == websocket.StatusNormalClosure || status == websocket.StatusGoingAway
}

// WebSocketDialer sends the connect credential only in the Authorization
// header and disables compression for opaque SSH ciphertext.
type WebSocketDialer struct {
	HTTPClient *http.Client
}

// Dial opens one bounded binary WebSocket stream.
func (d WebSocketDialer) Dial(ctx context.Context, connectURL, credential string) (Stream, error) {
	header := make(http.Header)
	header.Set("Authorization", "Bearer "+credential)
	dialCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	connection, _, err := websocket.Dial(dialCtx, connectURL, &websocket.DialOptions{
		HTTPClient:      d.HTTPClient,
		HTTPHeader:      header,
		CompressionMode: websocket.CompressionDisabled,
	})
	if err != nil {
		return nil, errors.New("WebSocket SSH handshake failed")
	}
	return wsstream.New(ctx, connection, 64*1024), nil
}

func safeConfigPath(path string) bool {
	return filepath.IsAbs(path) && filepath.Clean(path) == path && !strings.ContainsAny(path, "\r\n\t ")
}

// safeProxyBinaryPath holds a ProxyCommand executable to a stricter standard
// than safeConfigPath: OpenSSH treats IdentityFile as a filename but hands the
// ProxyCommand line to a shell, so anything a shell would interpret is refused.
func safeProxyBinaryPath(path string) bool {
	return safeConfigPath(path) && !strings.ContainsAny(path, proxyPathUnsafeRunes)
}

func canonicalHostPublicKey(value string) (string, error) {
	key, _, options, rest, err := cryptossh.ParseAuthorizedKey([]byte(value))
	if err != nil || len(options) != 0 || strings.TrimSpace(string(rest)) != "" || key.Type() != cryptossh.KeyAlgoED25519 {
		return "", ErrHostKeyMismatch
	}
	return strings.TrimSpace(string(cryptossh.MarshalAuthorizedKey(key))), nil
}

// PrepareSessionTarget readies one sandbox for a v2 dial and returns its host
// alias: it builds the alias, writes the strict wildcard session config, and
// pins the sandbox's host key.
//
// Shared by every command that hands a `*.amika` alias to system OpenSSH
// (`sandbox sshv2`, `scpv2`), so they cannot drift in how the identity is
// checked or the host key is pinned.
func PrepareSessionTarget(
	paths basedir.Paths,
	creator SessionCreator,
	sandboxName string,
	sandboxID string,
) (string, error) {
	environment, err := config.EnvironmentSlug()
	if err != nil {
		return "", err
	}
	alias, err := BuildSessionAlias(sandboxName, sandboxID, environment)
	if err != nil {
		return "", err
	}
	sessionConfig, err := resolveSessionConfig(paths)
	if err != nil {
		return "", err
	}
	// A world- or group-readable private key is refused rather than used:
	// OpenSSH would reject it anyway, and the clearer error names the fix.
	identityInfo, statErr := os.Stat(sessionConfig.IdentityFile)
	if statErr != nil || !identityInfo.Mode().IsRegular() || identityInfo.Mode().Perm()&0o077 != 0 {
		return "", fmt.Errorf("SSH identity is missing or unsafe; run %q", "amika secret ssh-keygen")
	}
	if err := ConfigureSession(paths, sessionConfig); err != nil {
		return "", err
	}
	if _, err := PrepareSessionHost(
		creator,
		FileHostKeyPinStore{Path: sessionConfig.KnownHostsFile},
		sandboxID,
		alias,
	); err != nil {
		return "", err
	}
	return alias, nil
}

// resolveSessionConfig returns the persisted session identity, or the default
// one built from the standard identity and known-hosts paths. The persisted
// value is honored so an identity imported by `amika ssh-keygen --import` keeps
// being used.
func resolveSessionConfig(paths basedir.Paths) (SessionConfig, error) {
	state, err := LoadState(paths)
	if err != nil {
		return SessionConfig{}, err
	}
	if state.SessionConfig != nil {
		return *state.SessionConfig, nil
	}
	identityFile, err := paths.SSHIdentityFile()
	if err != nil {
		return SessionConfig{}, err
	}
	knownHostsFile, err := paths.SSHKnownHostsFile()
	if err != nil {
		return SessionConfig{}, err
	}
	return SessionConfig{
		IdentityFile:   identityFile,
		KnownHostsFile: knownHostsFile,
	}, nil
}

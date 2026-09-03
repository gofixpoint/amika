package ssh

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"io"
	"strings"
	"testing"

	"github.com/coder/websocket"
	"github.com/gofixpoint/amika/go/internal/apiclient"
	cryptossh "golang.org/x/crypto/ssh"
)

func TestParseSessionAliasPopsEnvironmentAndIDFromTheRight(t *testing.T) {
	parsed, err := ParseSessionAlias("my.team.sbx-123.localhost-3011.amika")
	if err != nil {
		t.Fatalf("ParseSessionAlias: %v", err)
	}
	if parsed.Name != "my.team" || parsed.ID != "sbx-123" || parsed.Environment != "localhost-3011" {
		t.Fatalf("parsed = %#v", parsed)
	}
}

func TestBuildSessionAliasRoundTripsThroughParse(t *testing.T) {
	alias, err := BuildSessionAlias("my.team", "sbx-123", "app-amika-dev")
	if err != nil {
		t.Fatalf("BuildSessionAlias: %v", err)
	}
	if alias != "my.team.sbx-123.app-amika-dev.amika" {
		t.Fatalf("alias = %q", alias)
	}
	parsed, err := ParseSessionAlias(alias)
	if err != nil {
		t.Fatalf("ParseSessionAlias: %v", err)
	}
	if parsed.Name != "my.team" || parsed.ID != "sbx-123" || parsed.Environment != "app-amika-dev" {
		t.Fatalf("parsed = %#v", parsed)
	}
}

// A dot in the environment would be popped as its own segment and shift every
// other field, so it must be refused at build time.
func TestBuildSessionAliasRejectsDottedEnvironment(t *testing.T) {
	if _, err := BuildSessionAlias("team", "sbx-123", "app.amika.dev"); err == nil {
		t.Fatal("expected a dotted environment to be rejected")
	}
}

func TestRenderSessionConfigScopesTheWildcardToOneEnvironment(t *testing.T) {
	config, err := RenderSessionConfig(
		"localhost-3011",
		"/Users/dev/bin/amika-local plumbing ssh-stdio-proxy %h",
		SessionConfig{
			IdentityFile:   "/home/user/.ssh/amika_id_ed25519",
			KnownHostsFile: "/home/user/.ssh/amika_known_hosts",
		},
	)
	if err != nil {
		t.Fatalf("RenderSessionConfig: %v", err)
	}
	for _, line := range []string{
		"Host *.localhost-3011.amika",
		"User amika",
		"IdentityFile /home/user/.ssh/amika_id_ed25519",
		"IdentitiesOnly yes",
		"StrictHostKeyChecking yes",
		"UserKnownHostsFile /home/user/.ssh/amika_known_hosts",
		"ProxyCommand /Users/dev/bin/amika-local plumbing ssh-stdio-proxy %h",
		"ServerAliveInterval 15",
	} {
		if !strings.Contains(config, line) {
			t.Errorf("config missing %q:\n%s", line, config)
		}
	}
	// A bare `*.amika` would also match every other environment's aliases and
	// win the ProxyCommand for them, since OpenSSH takes the first value found.
	if strings.Contains(config, "Host *.amika") {
		t.Errorf("config still has an environment-agnostic wildcard:\n%s", config)
	}
}

// OpenSSH hands the ProxyCommand line to a shell, so only an absolute, clean,
// metacharacter-free executable path may be embedded in it.
func TestProxyCommandRejectsUnsafeExecutablePaths(t *testing.T) {
	for _, binaryPath := range []string{
		"amika",
		"bin/amika",
		"/usr/local/bin/amika; rm -rf /tmp/x",
		"/usr/local/bin/amika && curl evil.example",
		"/usr/local/bin/$(id)/amika",
		"/usr/local/bin/amika `id`",
		"/usr/local/bin/my amika",
		"/usr/local/bin/amika%h",
		"/usr/local/../bin/amika",
	} {
		if _, err := BuildProxyCommand(binaryPath); err == nil {
			t.Errorf("BuildProxyCommand(%q) was accepted", binaryPath)
		}
	}
}

func TestParseProxyCommandRequiresTheFixedInvocation(t *testing.T) {
	binaryPath, err := ParseProxyCommand("/usr/local/bin/amika plumbing ssh-stdio-proxy %h")
	if err != nil {
		t.Fatalf("ParseProxyCommand: %v", err)
	}
	if binaryPath != "/usr/local/bin/amika" {
		t.Fatalf("binary path = %q", binaryPath)
	}
	for _, proxyCommand := range []string{
		"/usr/local/bin/amika sandbox delete everything",
		"/usr/local/bin/amika plumbing ssh-stdio-proxy",
		"/usr/local/bin/amika plumbing ssh-stdio-proxy %h; id",
	} {
		if _, err := ParseProxyCommand(proxyCommand); err == nil {
			t.Errorf("ParseProxyCommand(%q) was accepted", proxyCommand)
		}
	}
}

func TestKnownHostLinePinsTheAliasToTheExactHostKey(t *testing.T) {
	hostKey := testHostKey(t)
	line, err := KnownHostLine(
		"my.team.sbx-123.localhost-3011.amika",
		hostKey+" host-comment",
	)
	if err != nil {
		t.Fatalf("KnownHostLine: %v", err)
	}
	if line != "my.team.sbx-123.localhost-3011.amika "+hostKey+"\n" {
		t.Fatalf("known-host line = %q", line)
	}
}

type fakeCreator struct {
	calls   int
	hostKey string
}

type fakePinStore struct {
	alias string
	key   string
	calls int
	err   error
}

func (s *fakePinStore) Pin(alias, key string) error {
	s.calls++
	s.alias = alias
	s.key = key
	return s.err
}

func TestPrepareSessionHostPinsAPIHostKeyBeforeOpenSSH(t *testing.T) {
	creator := &fakeCreator{hostKey: testHostKey(t)}
	pins := &fakePinStore{}
	session, err := PrepareSessionHost(
		creator,
		pins,
		"sbx_123",
		"my.team.sbx_123.localhost-3011.amika",
	)
	if err != nil {
		t.Fatalf("PrepareSessionHost: %v", err)
	}
	if session.SandboxID != "sbx_123" || creator.calls != 1 {
		t.Fatalf("session = %#v, creator calls = %d", session, creator.calls)
	}
	if pins.calls != 1 || pins.alias != "my.team.sbx_123.localhost-3011.amika" || pins.key != creator.hostKey {
		t.Fatalf("pin calls = %d alias = %q key = %q", pins.calls, pins.alias, pins.key)
	}
}

func (c *fakeCreator) CreateSSHSession(name string) (*apiclient.SSHSession, error) {
	c.calls++
	return &apiclient.SSHSession{
		SessionID:         "sshs_1",
		Transport:         "direct_ws",
		ConnectURL:        "wss://sandbox.example/v1/ssh-sessions",
		ConnectCredential: testConnectToken(),
		SandboxID:         name,
		SSHUser:           "amika",
		HostPublicKey:     c.hostKey,
	}, nil
}

type proxyStream struct {
	read    *bytes.Reader
	readErr error
	writes  bytes.Buffer
}

func (s *proxyStream) Read(p []byte) (int, error) {
	read, err := s.read.Read(p)
	if errors.Is(err, io.EOF) && s.readErr != nil {
		return read, s.readErr
	}
	return read, err
}
func (s *proxyStream) Write(p []byte) (int, error) { return s.writes.Write(p) }
func (s *proxyStream) Close() error                { return nil }

type fakeSessionDialer struct {
	stream     *proxyStream
	url        string
	credential string
	calls      int
	// Pin count as of the dial, for the ordering assertion.
	pins       *fakePinStore
	pinsAtDial int
}

func (d *fakeSessionDialer) Dial(_ context.Context, url, credential string) (Stream, error) {
	d.calls++
	d.url = url
	d.credential = credential
	if d.pins != nil {
		d.pinsAtDial = d.pins.calls
	}
	return d.stream, nil
}

func TestProxySessionCreatesSessionAndCopiesBytes(t *testing.T) {
	creator := &fakeCreator{hostKey: testHostKey(t)}
	stream := &proxyStream{read: bytes.NewReader([]byte("from-sshd"))}
	pins := &fakePinStore{}
	dialer := &fakeSessionDialer{stream: stream, pins: pins}
	var stdout bytes.Buffer

	err := ProxySession(
		context.Background(),
		creator,
		dialer,
		pins,
		"my.team.sbx_123.localhost-3011.amika",
		strings.NewReader("from-openssh"),
		&stdout,
	)
	if err != nil {
		t.Fatalf("ProxySession: %v", err)
	}
	if creator.calls != 1 || dialer.calls != 1 {
		t.Fatalf("creator calls = %d, dialer calls = %d", creator.calls, dialer.calls)
	}
	// The dialled alias, keyed to the host key the API just issued.
	if pins.calls != 1 || pins.alias != "my.team.sbx_123.localhost-3011.amika" || pins.key != creator.hostKey {
		t.Fatalf("pin calls = %d alias = %q key = %q", pins.calls, pins.alias, pins.key)
	}
	// Before the dial, not merely somewhere in the run: pinned afterwards, the
	// write would race the handshake.
	if dialer.pinsAtDial != 1 {
		t.Fatalf("pins at dial = %d, want the host key pinned before the transport opens", dialer.pinsAtDial)
	}
	if dialer.url != "wss://sandbox.example/v1/ssh-sessions" || dialer.credential != testConnectToken() {
		t.Fatalf("dial = %q credential %q", dialer.url, dialer.credential)
	}
	if got := stream.writes.String(); got != "from-openssh" {
		t.Fatalf("stream received %q", got)
	}
	if got := stdout.String(); got != "from-sshd" {
		t.Fatalf("stdout received %q", got)
	}
}

func TestProxySessionAcceptsNormalWebSocketClosure(t *testing.T) {
	creator := &fakeCreator{hostKey: testHostKey(t)}
	stream := &proxyStream{
		read:    bytes.NewReader(nil),
		readErr: websocket.CloseError{Code: websocket.StatusNormalClosure},
	}
	dialer := &fakeSessionDialer{stream: stream}

	if err := ProxySession(
		context.Background(),
		creator,
		dialer,
		&fakePinStore{},
		"my.team.sbx_123.localhost-3011.amika",
		strings.NewReader(""),
		io.Discard,
	); err != nil {
		t.Fatalf("ProxySession normal close: %v", err)
	}
}

// Pinning on every dial is only safe because a changed key still fails closed:
// the store refuses it and the transport is never opened.
func TestProxySessionRefusesChangedHostKeyBeforeDialing(t *testing.T) {
	creator := &fakeCreator{hostKey: testHostKey(t)}
	dialer := &fakeSessionDialer{stream: &proxyStream{read: bytes.NewReader(nil)}}

	err := ProxySession(
		context.Background(),
		creator,
		dialer,
		&fakePinStore{err: ErrHostKeyMismatch},
		"my.team.sbx_123.localhost-3011.amika",
		strings.NewReader(""),
		io.Discard,
	)
	if !errors.Is(err, ErrHostKeyMismatch) {
		t.Fatalf("ProxySession err = %v, want ErrHostKeyMismatch", err)
	}
	if dialer.calls != 0 {
		t.Fatalf("dialer calls = %d, want the transport left unopened", dialer.calls)
	}
}

func testConnectToken() string {
	return base64.RawURLEncoding.EncodeToString(make([]byte, 32))
}

func testHostKey(t *testing.T) string {
	t.Helper()
	public, _, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	key, err := cryptossh.NewPublicKey(public)
	if err != nil {
		t.Fatal(err)
	}
	return strings.TrimSpace(string(cryptossh.MarshalAuthorizedKey(key)))
}

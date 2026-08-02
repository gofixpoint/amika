package ssh

import (
	"bytes"
	"context"
	"strings"
	"testing"

	"github.com/gofixpoint/amika/go/internal/apiclient"
)

func TestParseSessionAliasUsesRightmostSandboxID(t *testing.T) {
	parsed, err := ParseSessionAlias("my.team.sbx-123.amika")
	if err != nil {
		t.Fatalf("ParseSessionAlias: %v", err)
	}
	if parsed.Name != "my.team" || parsed.ID != "sbx-123" {
		t.Fatalf("parsed = %#v", parsed)
	}
}

func TestRenderSessionConfigPinsHostKeysAndFetchesEveryDial(t *testing.T) {
	config, err := RenderSessionConfig(SessionConfig{
		IdentityFile:   "/home/user/.ssh/amika_id_ed25519",
		KnownHostsFile: "/home/user/.ssh/amika_known_hosts",
		ProxyCommand:   "amika plumbing ssh-stdio-proxy %h",
	})
	if err != nil {
		t.Fatalf("RenderSessionConfig: %v", err)
	}
	for _, line := range []string{
		"Host *.amika",
		"User amika",
		"IdentityFile /home/user/.ssh/amika_id_ed25519",
		"IdentitiesOnly yes",
		"StrictHostKeyChecking yes",
		"UserKnownHostsFile /home/user/.ssh/amika_known_hosts",
		"ProxyCommand amika plumbing ssh-stdio-proxy %h",
		"ServerAliveInterval 15",
	} {
		if !strings.Contains(config, line) {
			t.Errorf("config missing %q:\n%s", line, config)
		}
	}
}

func TestKnownHostLinePinsTheAliasToTheExactHostKey(t *testing.T) {
	line, err := KnownHostLine(
		"my.team.sbx-123.amika",
		"ssh-ed25519 AAAAtest host-comment",
	)
	if err != nil {
		t.Fatalf("KnownHostLine: %v", err)
	}
	if line != "my.team.sbx-123.amika ssh-ed25519 AAAAtest\n" {
		t.Fatalf("known-host line = %q", line)
	}
}

type fakeCreator struct {
	calls int
}

type fakePinStore struct {
	alias string
	key   string
	calls int
}

func (s *fakePinStore) Pin(alias, key string) error {
	s.calls++
	s.alias = alias
	s.key = key
	return nil
}

func TestPrepareSessionHostPinsAPIHostKeyBeforeOpenSSH(t *testing.T) {
	creator := &fakeCreator{}
	pins := &fakePinStore{}
	session, err := PrepareSessionHost(
		creator,
		pins,
		"sbx_123",
		"my.team.sbx-123.amika",
	)
	if err != nil {
		t.Fatalf("PrepareSessionHost: %v", err)
	}
	if session.SandboxID != "sbx_123" || creator.calls != 1 {
		t.Fatalf("session = %#v, creator calls = %d", session, creator.calls)
	}
	if pins.calls != 1 || pins.alias != "my.team.sbx-123.amika" || pins.key != "ssh-ed25519 AAAAtest" {
		t.Fatalf("pin calls = %d alias = %q key = %q", pins.calls, pins.alias, pins.key)
	}
}

func (c *fakeCreator) CreateSSHSession(name string) (*apiclient.SSHSession, error) {
	c.calls++
	return &apiclient.SSHSession{
		SessionID:         "sshs_1",
		Transport:         "direct_ws",
		ConnectURL:        "wss://sandbox.example/v1/ssh-sessions",
		ConnectCredential: "connect-token",
		SandboxID:         name,
		SSHUser:           "amika",
		HostPublicKey:     "ssh-ed25519 AAAAtest",
	}, nil
}

type proxyStream struct {
	read   *bytes.Reader
	writes bytes.Buffer
}

func (s *proxyStream) Read(p []byte) (int, error)  { return s.read.Read(p) }
func (s *proxyStream) Write(p []byte) (int, error) { return s.writes.Write(p) }
func (s *proxyStream) Close() error                { return nil }

type fakeSessionDialer struct {
	stream     *proxyStream
	url        string
	credential string
	calls      int
}

func (d *fakeSessionDialer) Dial(_ context.Context, url, credential string) (Stream, error) {
	d.calls++
	d.url = url
	d.credential = credential
	return d.stream, nil
}

func TestProxySessionCreatesSessionAndCopiesBytes(t *testing.T) {
	creator := &fakeCreator{}
	stream := &proxyStream{read: bytes.NewReader([]byte("from-sshd"))}
	dialer := &fakeSessionDialer{stream: stream}
	var stdout bytes.Buffer

	err := ProxySession(
		context.Background(),
		creator,
		dialer,
		"sbx_123",
		strings.NewReader("from-openssh"),
		&stdout,
	)
	if err != nil {
		t.Fatalf("ProxySession: %v", err)
	}
	if creator.calls != 1 || dialer.calls != 1 {
		t.Fatalf("creator calls = %d, dialer calls = %d", creator.calls, dialer.calls)
	}
	if dialer.url != "wss://sandbox.example/v1/ssh-sessions" || dialer.credential != "connect-token" {
		t.Fatalf("dial = %q credential %q", dialer.url, dialer.credential)
	}
	if got := stream.writes.String(); got != "from-openssh" {
		t.Fatalf("stream received %q", got)
	}
	if got := stdout.String(); got != "from-sshd" {
		t.Fatalf("stdout received %q", got)
	}
}

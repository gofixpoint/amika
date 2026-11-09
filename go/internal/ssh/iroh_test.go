package ssh

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gofixpoint/amika/go/internal/amikad/norelay"
	"github.com/gofixpoint/amika/go/internal/amikanet"
	"github.com/gofixpoint/amika/go/internal/apiclient"
	"github.com/gofixpoint/amika/go/internal/basedir"
	"github.com/gofixpoint/amika/go/internal/sshresume"
	cryptossh "golang.org/x/crypto/ssh"
)

// The fake amika-net is this test binary, started again with
// fakeAmikaNetEnv set. It pipes its stdin and stdout to a TCP address, as
// `amika-net connect` pipes them to an iroh stream.
const (
	fakeAmikaNetEnv = "TEST_FAKE_AMIKA_NET"
	// fakeAmikaNetAddrEnv is the address the fake connects to.
	fakeAmikaNetAddrEnv = "TEST_FAKE_AMIKA_NET_ADDR"
	// fakeAmikaNetLogEnv is a file the fake appends its argv to, one JSON
	// line per process.
	fakeAmikaNetLogEnv = "TEST_FAKE_AMIKA_NET_LOG"
	// fakeAmikaNetFailEnv, when set, makes the fake print it to stderr and
	// exit 1 before it connects, as amika-net does when the host refuses.
	fakeAmikaNetFailEnv = "TEST_FAKE_AMIKA_NET_FAIL"
	// fakeAmikaNetCutFirstEnv cuts the first process's stream after this
	// many bytes from the rig, as a lost iroh connection ends it.
	fakeAmikaNetCutFirstEnv = "TEST_FAKE_AMIKA_NET_CUT_FIRST"
)

func TestMain(m *testing.M) {
	if os.Getenv(fakeAmikaNetEnv) == "1" {
		os.Exit(runFakeAmikaNet(os.Args[1:]))
	}
	os.Exit(m.Run())
}

func runFakeAmikaNet(args []string) int {
	index := 0
	if logPath := os.Getenv(fakeAmikaNetLogEnv); logPath != "" {
		if previous, err := os.ReadFile(logPath); err == nil {
			index = bytes.Count(previous, []byte("\n"))
		}
		line, _ := json.Marshal(args)
		file, err := os.OpenFile(logPath, os.O_WRONLY|os.O_APPEND|os.O_CREATE, 0o600)
		if err == nil {
			_, _ = file.Write(append(line, '\n'))
			_ = file.Close()
		}
	}
	if reason := os.Getenv(fakeAmikaNetFailEnv); reason != "" {
		fmt.Fprintln(os.Stderr, "INFO dialing the host")
		fmt.Fprintln(os.Stderr, reason)
		return 1
	}
	conn, err := net.Dial("tcp", os.Getenv(fakeAmikaNetAddrEnv))
	if err != nil {
		fmt.Fprintln(os.Stderr, "Error: dial failed")
		return 1
	}
	go func() {
		_, _ = io.Copy(conn, os.Stdin)
		_ = conn.(*net.TCPConn).CloseWrite()
	}()
	if cut := os.Getenv(fakeAmikaNetCutFirstEnv); cut != "" && index == 0 {
		budget, _ := strconv.ParseInt(cut, 10, 64)
		_, _ = io.CopyN(os.Stdout, conn, budget)
		_ = conn.Close()
		fmt.Fprintln(os.Stderr, "Error: connection lost")
		return 1
	}
	_, _ = io.Copy(os.Stdout, conn)
	return 0
}

// irohRig is amikad's real handler, served over plain HTTP for the fake
// amika-net and over TLS for direct_ws.
type irohRig struct {
	hostKey  cryptossh.Signer
	plain    *httptest.Server
	tls      *httptest.Server
	argvLog  string
	keyFile  string
	paths    sync.Map
	sshdDial atomic.Int32
}

func newIrohRig(t *testing.T) *irohRig {
	t.Helper()
	rig := &irohRig{hostKey: newHostSigner(t)}
	handler := norelay.NewHandler(norelay.Config{}, norelay.Dependencies{
		Verifier:      rigVerifier{},
		Upgrader:      norelay.WebSocketUpgrader{},
		FrameUpgrader: norelay.WebSocketUpgrader{},
		Dialer: dialerFunc(func() (norelay.Stream, error) {
			rig.sshdDial.Add(1)
			amikad, sshd := net.Pipe()
			go serveEchoSSH(sshd, rig.hostKey)
			return amikad, nil
		}),
	})
	recording := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		rig.paths.Store(r.URL.Path, true)
		handler.ServeHTTP(w, r)
	})
	rig.plain = httptest.NewServer(recording)
	// The direct_ws route goes through a gateway that strips its prefix.
	rig.tls = httptest.NewTLSServer(http.StripPrefix(gatewayPrefix, recording))
	t.Cleanup(func() {
		handler.Close()
		rig.plain.Close()
		rig.tls.Close()
	})
	dir := t.TempDir()
	rig.argvLog = filepath.Join(dir, "argv.log")
	rig.keyFile = filepath.Join(dir, "device.key")
	t.Setenv(fakeAmikaNetEnv, "1")
	t.Setenv(fakeAmikaNetAddrEnv, rig.plain.Listener.Addr().String())
	t.Setenv(fakeAmikaNetLogEnv, rig.argvLog)
	return rig
}

func (r *irohRig) route() *IrohRoute {
	binary, err := os.Executable()
	if err != nil {
		panic(err)
	}
	return &IrohRoute{Binary: binary, KeyFile: r.keyFile}
}

// connects returns the argv of every fake amika-net process so far.
func (r *irohRig) connects(t *testing.T) [][]string {
	t.Helper()
	data, err := os.ReadFile(r.argvLog)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		t.Fatal(err)
	}
	var all [][]string
	for line := range strings.SplitSeq(strings.TrimSpace(string(data)), "\n") {
		var argv []string
		if err := json.Unmarshal([]byte(line), &argv); err != nil {
			t.Fatal(err)
		}
		all = append(all, argv)
	}
	return all
}

func (r *irohRig) sawPath(path string) bool {
	_, ok := r.paths.Load(path)
	return ok
}

// irohCreator hands out an iroh descriptor whose direct_ws route is the
// rig's TLS server, and records the transports each request listed.
type irohCreator struct {
	rig        *irohRig
	mu         sync.Mutex
	transports [][]apiclient.SSHSessionTransport
}

// gatewayPrefix is the path a gateway puts before amikad's routes.
const gatewayPrefix = "/rigs/r1"

const testEndpointID = "0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f"

func (c *irohCreator) CreateSSHSession(id string, transports []apiclient.SSHSessionTransport) (*apiclient.SSHSession, error) {
	c.mu.Lock()
	c.transports = append(c.transports, transports)
	c.mu.Unlock()
	relay := "https://relay.example"
	return &apiclient.SSHSession{
		SessionID:         "sshs_1",
		Transport:         apiclient.SSHSessionTransportIroh,
		ConnectURL:        "wss" + strings.TrimPrefix(c.rig.tls.URL, "https") + gatewayPrefix + v1SessionsSuffix,
		ConnectCredential: testConnectToken(),
		SandboxID:         id,
		SSHUser:           apiclient.DefaultSSHUser,
		HostPublicKey:     strings.TrimSpace(string(cryptossh.MarshalAuthorizedKey(c.rig.hostKey.PublicKey()))),
		Iroh: &apiclient.SSHSessionIroh{
			EndpointID: testEndpointID,
			RelayURL:   &relay,
			RigID:      "rig_1",
			Port:       60899,
		},
	}, nil
}

// countingDialer is the direct_ws dialer, and counts its dials.
type countingDialer struct {
	WebSocketDialer
	dials atomic.Int32
}

func (d *countingDialer) DialTransport(ctx context.Context, url, credential string) (sshresume.Transport, error) {
	d.dials.Add(1)
	return d.WebSocketDialer.DialTransport(ctx, url, credential)
}

func (d *countingDialer) Dial(ctx context.Context, url, credential string) (Stream, error) {
	d.dials.Add(1)
	return d.WebSocketDialer.Dial(ctx, url, credential)
}

// sshThroughProxy runs ProxySession and an SSH client over it, echoes
// payload through the rig, and returns the proxy's events and result.
func sshThroughProxy(t *testing.T, rig *irohRig, creator SessionCreator, direct ProxyDialer, options ProxyOptions, payload []byte) (string, error) {
	t.Helper()
	events := &lockedBuffer{}
	proxyEnd, opensshEnd := net.Pipe()
	result := make(chan error, 1)
	go func() {
		result <- ProxySession(context.Background(), creator, direct, &fakePinStore{}, "my.team.sbx_123.localhost-3011.amika", proxyEnd, proxyEnd, slog.New(slog.NewJSONHandler(events, nil)), options)
	}()
	type handshake struct {
		client *cryptossh.Client
		err    error
	}
	connected := make(chan handshake, 1)
	go func() {
		connection, channels, requests, err := cryptossh.NewClientConn(opensshEnd, "rig", &cryptossh.ClientConfig{
			User:            "amika",
			HostKeyCallback: cryptossh.FixedHostKey(rig.hostKey.PublicKey()),
			Timeout:         10 * time.Second,
		})
		if err != nil {
			connected <- handshake{err: err}
			return
		}
		connected <- handshake{client: cryptossh.NewClient(connection, channels, requests)}
	}()
	var client *cryptossh.Client
	select {
	case got := <-connected:
		if got.err != nil {
			_ = opensshEnd.Close()
			return events.String(), waitResult(t, result)
		}
		client = got.client
	case err := <-result:
		_ = opensshEnd.Close()
		return events.String(), err
	}
	channel, channelRequests, err := client.OpenChannel("echo", nil)
	if err != nil {
		t.Fatalf("open channel: %v", err)
	}
	go cryptossh.DiscardRequests(channelRequests)
	go func() {
		_, _ = channel.Write(payload)
		_ = channel.CloseWrite()
	}()
	echoed, err := io.ReadAll(channel)
	if err != nil || !bytes.Equal(echoed, payload) {
		t.Fatalf("echoed %d of %d bytes, err %v", len(echoed), len(payload), err)
	}
	_ = client.Close()
	return events.String(), waitResult(t, result)
}

func TestProxySessionCarriesSSHOverIroh(t *testing.T) {
	rig := newIrohRig(t)
	creator := &irohCreator{rig: rig}
	direct := &countingDialer{WebSocketDialer: WebSocketDialer{HTTPClient: rig.tls.Client()}}

	events, err := sshThroughProxy(t, rig, creator, direct, ProxyOptions{Iroh: rig.route()}, []byte("over iroh"))
	if err != nil {
		t.Fatalf("proxy exit = %v", err)
	}
	if direct.dials.Load() != 0 {
		t.Fatalf("direct_ws dials = %d, want 0", direct.dials.Load())
	}
	wantTransports := []apiclient.SSHSessionTransport{apiclient.SSHSessionTransportDirectWS, apiclient.SSHSessionTransportIroh}
	if !reflect.DeepEqual(creator.transports, [][]apiclient.SSHSessionTransport{wantTransports}) {
		t.Fatalf("transports = %v", creator.transports)
	}
	connects := rig.connects(t)
	wantArgv := []string{"connect", "--key-file", rig.keyFile, "--endpoint", testEndpointID, "--relay-url", "https://relay.example", "--target", "rig:rig_1:60899"}
	if len(connects) != 1 || !reflect.DeepEqual(connects[0], wantArgv) {
		t.Fatalf("connects = %q", connects)
	}
	// The stream ends at amikad itself, so the request skips the gateway's
	// path prefix in connect_url.
	if !rig.sawPath(v2SessionsSuffix) || rig.sawPath(gatewayPrefix+v2SessionsSuffix) {
		t.Fatal("the iroh WebSocket did not ask for amikad's own /v2 route")
	}
	if !strings.Contains(events, `"msg":"ssh_transport","transport":"iroh"`) || strings.Contains(events, testConnectToken()) {
		t.Fatalf("events = %s", events)
	}
}

// noRelayCreator hands out an iroh descriptor with a null relay_url,
// which the contract says the control plane never sends.
type noRelayCreator struct{ irohCreator }

func (c *noRelayCreator) CreateSSHSession(id string, transports []apiclient.SSHSessionTransport) (*apiclient.SSHSession, error) {
	session, err := c.irohCreator.CreateSSHSession(id, transports)
	session.Iroh.RelayURL = nil
	return session, err
}

func TestProxySessionUsesDirectWSForAnIrohDescriptorWithNoRelay(t *testing.T) {
	rig := newIrohRig(t)
	direct := &countingDialer{WebSocketDialer: WebSocketDialer{HTTPClient: rig.tls.Client()}}
	route := rig.route()
	var forgot atomic.Int32
	route.Forget = func() { forgot.Add(1) }

	events, err := sshThroughProxy(t, rig, &noRelayCreator{irohCreator{rig: rig}}, direct, ProxyOptions{Iroh: route}, []byte("no relay"))
	if err != nil {
		t.Fatalf("proxy exit = %v", err)
	}
	if direct.dials.Load() == 0 || len(rig.connects(t)) != 0 || forgot.Load() != 0 {
		t.Fatalf("direct_ws dials = %d, connects = %d, forgot = %d", direct.dials.Load(), len(rig.connects(t)), forgot.Load())
	}
	if !strings.Contains(events, `"msg":"ssh_transport_fallback","from":"iroh","reason":"the iroh descriptor has no relay_url"`) {
		t.Fatalf("events = %s", events)
	}

	events, err = sshThroughProxy(t, rig, &noRelayCreator{irohCreator{rig: rig}}, direct, ProxyOptions{Transport: TransportIroh, Iroh: route}, nil)
	if err == nil || !strings.Contains(err.Error(), "no relay_url") || len(rig.connects(t)) != 0 {
		t.Fatalf("--transport iroh: err = %v, connects = %d", err, len(rig.connects(t)))
	}
	if !strings.Contains(events, `"msg":"ssh_transport_failed"`) {
		t.Fatalf("events = %s", events)
	}
}

func TestProxySessionFallsBackToDirectWSWhenAmikaNetFails(t *testing.T) {
	rig := newIrohRig(t)
	t.Setenv(fakeAmikaNetFailEnv, "Error: host refused rig:rig_1:60899: NotAllowed")
	direct := &countingDialer{WebSocketDialer: WebSocketDialer{HTTPClient: rig.tls.Client()}}
	route := rig.route()
	var forgot atomic.Int32
	route.Forget = func() { forgot.Add(1) }

	events, err := sshThroughProxy(t, rig, &irohCreator{rig: rig}, direct, ProxyOptions{Iroh: route}, []byte("fallback"))
	if err != nil {
		t.Fatalf("proxy exit = %v", err)
	}
	if direct.dials.Load() == 0 || len(rig.connects(t)) != 1 {
		t.Fatalf("direct_ws dials = %d, connects = %d", direct.dials.Load(), len(rig.connects(t)))
	}
	if !strings.Contains(events, `"msg":"ssh_transport_fallback"`) || !strings.Contains(events, "host refused rig:rig_1:60899: NotAllowed") {
		t.Fatalf("events = %s", events)
	}
	if forgot.Load() != 1 {
		t.Fatalf("Forget calls = %d, want 1", forgot.Load())
	}
}

func TestProxySessionFallsBackWhenAmikaNetCannotStart(t *testing.T) {
	rig := newIrohRig(t)
	direct := &countingDialer{WebSocketDialer: WebSocketDialer{HTTPClient: rig.tls.Client()}}
	route := &IrohRoute{Binary: filepath.Join(t.TempDir(), "missing", "amika-net"), KeyFile: rig.keyFile}

	events, err := sshThroughProxy(t, rig, &irohCreator{rig: rig}, direct, ProxyOptions{Iroh: route}, []byte("fallback"))
	if err != nil {
		t.Fatalf("proxy exit = %v", err)
	}
	if direct.dials.Load() == 0 || !strings.Contains(events, `"reason":"could not start amika-net"`) {
		t.Fatalf("direct_ws dials = %d, events = %s", direct.dials.Load(), events)
	}
}

func TestProxySessionWithTransportIrohDoesNotFallBack(t *testing.T) {
	rig := newIrohRig(t)
	t.Setenv(fakeAmikaNetFailEnv, "Error: host refused rig:rig_1:60899: NotAllowed")
	direct := &countingDialer{WebSocketDialer: WebSocketDialer{HTTPClient: rig.tls.Client()}}
	creator := &irohCreator{rig: rig}

	events, err := sshThroughProxy(t, rig, creator, direct, ProxyOptions{Transport: TransportIroh, Iroh: rig.route()}, nil)
	if err == nil || !strings.Contains(err.Error(), "SSH over iroh failed") || !strings.Contains(err.Error(), "NotAllowed") {
		t.Fatalf("proxy exit = %v", err)
	}
	if direct.dials.Load() != 0 || rig.sshdDial.Load() != 0 {
		t.Fatalf("direct_ws dials = %d, sshd dials = %d", direct.dials.Load(), rig.sshdDial.Load())
	}
	if !reflect.DeepEqual(creator.transports, [][]apiclient.SSHSessionTransport{{apiclient.SSHSessionTransportIroh}}) {
		t.Fatalf("transports = %v", creator.transports)
	}
	if !strings.Contains(events, `"msg":"ssh_transport_failed"`) || strings.Contains(events, "ssh_transport_fallback") {
		t.Fatalf("events = %s", events)
	}
}

func TestProxySessionResumesOverANewConnectProcess(t *testing.T) {
	rig := newIrohRig(t)
	t.Setenv(fakeAmikaNetCutFirstEnv, strconv.Itoa(200<<10))
	direct := &countingDialer{WebSocketDialer: WebSocketDialer{HTTPClient: rig.tls.Client()}}
	payload := bytes.Repeat([]byte("0123456789abcdef"), 64<<10)

	events, err := sshThroughProxy(t, rig, &irohCreator{rig: rig}, direct, ProxyOptions{Iroh: rig.route()}, payload)
	if err != nil {
		t.Fatalf("proxy exit = %v", err)
	}
	if direct.dials.Load() != 0 || rig.sshdDial.Load() != 1 {
		t.Fatalf("direct_ws dials = %d, sshd dials = %d", direct.dials.Load(), rig.sshdDial.Load())
	}
	if connects := rig.connects(t); len(connects) < 2 {
		t.Fatalf("connect processes = %d, want a new one for the resume", len(connects))
	}
	if !strings.Contains(events, `"msg":"ssh_resume_attach"`) || strings.Contains(events, "ssh_transport_fallback") {
		t.Fatalf("events = %s", events)
	}
}

func TestProxyOptionsTransports(t *testing.T) {
	route := &IrohRoute{}
	direct := []apiclient.SSHSessionTransport{apiclient.SSHSessionTransportDirectWS}
	iroh := []apiclient.SSHSessionTransport{apiclient.SSHSessionTransportIroh}
	both := []apiclient.SSHSessionTransport{apiclient.SSHSessionTransportDirectWS, apiclient.SSHSessionTransportIroh}
	for name, test := range map[string]struct {
		options ProxyOptions
		want    []apiclient.SSHSessionTransport
	}{
		"amika-net missing":    {ProxyOptions{}, direct},
		"amika-net ready":      {ProxyOptions{Iroh: route}, both},
		"--transport iroh":     {ProxyOptions{Transport: TransportIroh, Iroh: route}, iroh},
		"--transport direct":   {ProxyOptions{Transport: TransportDirectWS, Iroh: route}, direct},
		"--transport direct 2": {ProxyOptions{Transport: TransportDirectWS}, direct},
	} {
		if got := test.options.transports(); !reflect.DeepEqual(got, test.want) {
			t.Errorf("%s: transports = %v, want %v", name, got, test.want)
		}
	}
}

func TestParseProxyTransport(t *testing.T) {
	for value, want := range map[string]ProxyTransport{"": TransportAuto, "iroh": TransportIroh, "direct_ws": TransportDirectWS} {
		if got, err := ParseProxyTransport(value); err != nil || got != want {
			t.Errorf("%q: %q, %v", value, got, err)
		}
	}
	if _, err := ParseProxyTransport("tunnel"); err == nil {
		t.Error("an unknown transport parsed")
	}
}

type recordingCreator struct {
	transports []apiclient.SSHSessionTransport
}

func (c *recordingCreator) CreateSSHSession(_ string, transports []apiclient.SSHSessionTransport) (*apiclient.SSHSession, error) {
	c.transports = transports
	return nil, apiclient.ErrSSHTransportUnavailable
}

func TestWithTransportAsksForOneTransport(t *testing.T) {
	inner := &recordingCreator{}
	_, _ = WithTransport(inner, TransportIroh).CreateSSHSession("sbx_1", nil)
	if !reflect.DeepEqual(inner.transports, []apiclient.SSHSessionTransport{apiclient.SSHSessionTransportIroh}) {
		t.Fatalf("transports = %v", inner.transports)
	}
	if WithTransport(inner, TransportAuto) != SessionCreator(inner) {
		t.Fatal("TransportAuto wrapped the creator")
	}
}

func TestProxySessionNamesTheFlagWhenTheServerCannotGiveIroh(t *testing.T) {
	err := ProxySession(context.Background(), &recordingCreator{}, &countingDialer{}, &fakePinStore{}, "my.team.sbx_123.localhost-3011.amika", strings.NewReader(""), io.Discard, nil, ProxyOptions{Transport: TransportIroh, Iroh: &IrohRoute{}})
	if !errors.Is(err, apiclient.ErrSSHTransportUnavailable) || !strings.HasPrefix(err.Error(), "--transport iroh: ") {
		t.Fatalf("err = %v", err)
	}
}

func TestTransportProxyCommandOption(t *testing.T) {
	binary, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("AMIKA_BINARY_PATH", binary)
	option, err := TransportProxyCommandOption(TransportIroh)
	if err != nil {
		t.Fatal(err)
	}
	if option != "ProxyCommand="+binary+" plumbing ssh-stdio-proxy --transport iroh %h" {
		t.Fatalf("option = %q", option)
	}
	if _, err := TransportProxyCommandOption(TransportAuto); err == nil {
		t.Fatal("TransportAuto gave an option")
	}
}

func TestIrohWebSocketURLKeepsOnlyAmikadsRoute(t *testing.T) {
	for in, want := range map[string]string{
		"wss://h.example/v2/ssh-sessions":          "ws://h.example/v2/ssh-sessions",
		"wss://h.example/rigs/r1/v1/ssh-sessions":  "ws://h.example/v1/ssh-sessions",
		"wss://h.example:8443/a/b/v2/ssh-sessions": "ws://h.example:8443/v2/ssh-sessions",
	} {
		if got, err := irohWebSocketURL(in); err != nil || got != want {
			t.Errorf("%s: %q, %v", in, got, err)
		}
	}
	if _, err := irohWebSocketURL("wss://h.example/other"); err == nil {
		t.Error("an unknown route was accepted")
	}
}

type countingRegistrar struct {
	calls int
	err   error
}

func (r *countingRegistrar) RegisterDevice(apiclient.RegisterDeviceRequest) (*apiclient.Device, error) {
	r.calls++
	if r.err != nil {
		return nil, r.err
	}
	return &apiclient.Device{DeviceID: "dev_01"}, nil
}

var testAccount = amikanet.Account{APIURL: "https://app.amika.dev", UserID: "user:u_1"}

func TestPrepareIrohRouteMakesAndRegistersTheDeviceKey(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", "")
	paths := basedir.New(t.TempDir())
	registrar := &countingRegistrar{}
	setup := IrohSetup{
		Paths:      paths,
		Account:    testAccount,
		Registrar:  registrar,
		FindBinary: func() (string, error) { return "/opt/amika/amika-net", nil },
	}
	for range 2 {
		route, err := PrepareIrohRoute(setup, TransportAuto, slog.New(slog.DiscardHandler))
		if err != nil || route == nil || route.Binary != "/opt/amika/amika-net" {
			t.Fatalf("route = %+v, %v", route, err)
		}
		keyFile, _ := amikanet.DeviceKeyFile(paths)
		if route.KeyFile != keyFile {
			t.Fatalf("key file = %q, want %q", route.KeyFile, keyFile)
		}
		if _, err := os.Stat(keyFile); err != nil {
			t.Fatalf("no device key: %v", err)
		}
	}
	if registrar.calls != 1 {
		t.Fatalf("registrations = %d, want 1", registrar.calls)
	}
}

func TestPrepareIrohRouteReportsAMissingBinaryOnce(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", "")
	missing := IrohSetup{
		Paths:      basedir.New(t.TempDir()),
		Account:    testAccount,
		Registrar:  &countingRegistrar{},
		FindBinary: func() (string, error) { return "", amikanet.ErrNotInstalled },
	}
	events := &lockedBuffer{}
	route, err := PrepareIrohRoute(missing, TransportAuto, slog.New(slog.NewJSONHandler(events, nil)))
	if err != nil || route != nil {
		t.Fatalf("route = %+v, %v", route, err)
	}
	if strings.Count(events.String(), "\n") != 1 || !strings.Contains(events.String(), `"reason":"amika_net_missing"`) {
		t.Fatalf("events = %s", events.String())
	}

	if _, err := PrepareIrohRoute(missing, TransportIroh, slog.New(slog.DiscardHandler)); !errors.Is(err, amikanet.ErrNotInstalled) {
		t.Fatalf("--transport iroh: err = %v", err)
	}

	looked := false
	missing.FindBinary = func() (string, error) { looked = true; return "", amikanet.ErrNotInstalled }
	if route, err := PrepareIrohRoute(missing, TransportDirectWS, slog.New(slog.DiscardHandler)); route != nil || err != nil || looked {
		t.Fatalf("--transport direct_ws: route %+v, err %v, looked %v", route, err, looked)
	}
}

func TestPrepareIrohRouteUsesDirectWSWhenAnotherUserHasTheKey(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", "")
	registrar := &countingRegistrar{err: &apiclient.HTTPError{StatusCode: 409, Body: `{"code":"device_endpoint_taken","message":"taken"}`}}
	setup := IrohSetup{
		Paths:      basedir.New(t.TempDir()),
		Account:    testAccount,
		Registrar:  registrar,
		FindBinary: func() (string, error) { return "/opt/amika/amika-net", nil },
	}
	events := &lockedBuffer{}
	for range 3 {
		route, err := PrepareIrohRoute(setup, TransportAuto, slog.New(slog.NewJSONHandler(events, nil)))
		if err != nil || route != nil {
			t.Fatalf("route = %+v, %v", route, err)
		}
	}
	if registrar.calls != 1 {
		t.Fatalf("registrations = %d, want 1: a refusal must not be asked again", registrar.calls)
	}
	if !strings.Contains(events.String(), `"reason":"device_key_taken"`) {
		t.Fatalf("events = %s", events.String())
	}
	if _, err := PrepareIrohRoute(setup, TransportIroh, slog.New(slog.DiscardHandler)); !errors.Is(err, amikanet.ErrKeyTaken) {
		t.Fatalf("--transport iroh: err = %v", err)
	}
}

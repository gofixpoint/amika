package ssh

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
	"github.com/gofixpoint/amika/go/internal/amikanet"
	"github.com/gofixpoint/amika/go/internal/apiclient"
	"github.com/gofixpoint/amika/go/internal/basedir"
	"github.com/gofixpoint/amika/go/internal/sshresume"
	"github.com/gofixpoint/amika/go/internal/wsstream"
)

// ProxyTransport is the transport the hidden `--transport` flag asks for.
// TransportAuto lets the proxy choose.
type ProxyTransport string

const (
	// TransportAuto lists every transport the CLI can use, and falls back
	// from iroh to direct_ws when the iroh path fails.
	TransportAuto ProxyTransport = ""
	// TransportIroh asks for iroh alone, with no fallback.
	TransportIroh ProxyTransport = ProxyTransport(apiclient.SSHSessionTransportIroh)
	// TransportDirectWS asks for direct_ws alone.
	TransportDirectWS ProxyTransport = ProxyTransport(apiclient.SSHSessionTransportDirectWS)
)

// ParseProxyTransport reads a `--transport` value.
func ParseProxyTransport(value string) (ProxyTransport, error) {
	switch transport := ProxyTransport(value); transport {
	case TransportAuto, TransportIroh, TransportDirectWS:
		return transport, nil
	}
	return "", fmt.Errorf("unknown --transport %q; use %q or %q", value, TransportIroh, TransportDirectWS)
}

// IrohRoute is a usable amika-net: the binary, and a device key file that
// the control plane has registered.
type IrohRoute struct {
	Binary  string
	KeyFile string
	// Forget, if set, runs when the iroh path fails before its WebSocket
	// opens, so the next proxy registers the device again.
	Forget func()
}

// ProxyOptions selects the transports ProxySession may use.
type ProxyOptions struct {
	Transport ProxyTransport
	// Iroh is nil when amika-net cannot be used.
	Iroh *IrohRoute
	// IrohUnavailable says why Iroh is nil, for Notice.
	IrohUnavailable string
	// Notice, if set, gets one line once the transport is settled: the
	// transport, and why it is not iroh when the CLI knows. `rig ssh -v`
	// sets it to stderr. It never gets a key, a token or a secret.
	Notice io.Writer
}

// notice writes the transport line, if asked for.
func (o ProxyOptions) notice(transport apiclient.SSHSessionTransport, why string) {
	if o.Notice == nil {
		return
	}
	line := "amika: SSH transport: " + string(transport)
	if why != "" {
		line += " (" + why + ")"
	}
	_, _ = fmt.Fprintln(o.Notice, line)
}

// transports is the list the session create request sends.
func (o ProxyOptions) transports() []apiclient.SSHSessionTransport {
	switch o.Transport {
	case TransportIroh:
		return []apiclient.SSHSessionTransport{apiclient.SSHSessionTransportIroh}
	case TransportDirectWS:
		return []apiclient.SSHSessionTransport{apiclient.SSHSessionTransportDirectWS}
	}
	if o.Iroh != nil {
		return []apiclient.SSHSessionTransport{apiclient.SSHSessionTransportDirectWS, apiclient.SSHSessionTransportIroh}
	}
	return []apiclient.SSHSessionTransport{apiclient.SSHSessionTransportDirectWS}
}

// WithTransport returns a creator whose every request asks for transport
// alone. TransportAuto returns creator unchanged. `rig ssh --transport`
// uses it, so a transport the server cannot give fails before ssh starts.
func WithTransport(creator SessionCreator, transport ProxyTransport) SessionCreator {
	if transport == TransportAuto {
		return creator
	}
	return forcedTransportCreator{creator: creator, transports: ProxyOptions{Transport: transport}.transports()}
}

type forcedTransportCreator struct {
	creator    SessionCreator
	transports []apiclient.SSHSessionTransport
}

func (c forcedTransportCreator) CreateSSHSession(sandboxID string, _ []apiclient.SSHSessionTransport) (*apiclient.SSHSession, error) {
	return c.creator.CreateSSHSession(sandboxID, c.transports)
}

// IrohSetup is what PrepareIrohRoute needs from the CLI.
type IrohSetup struct {
	Paths basedir.Paths
	// Account is the control plane and logged-in user the device key is
	// registered for. A second account on the machine registers for
	// itself.
	Account   amikanet.Account
	Registrar amikanet.Registrar
	// FindBinary locates amika-net. Nil is amikanet.FindBinary.
	FindBinary func() (string, error)
	// Stderr gets the one-time notice that the user removed this device.
	// Nil discards it.
	Stderr io.Writer
}

// PrepareIrohRoute finds amika-net, makes the device key on first use, and
// registers it once for the account. It returns a nil route, after one
// line in events, when iroh cannot be used: amika-net is missing, or the
// control plane refuses the key. The string says why, for verbose output.
// That is an error only when transport is TransportIroh.
//
// When the control plane first refuses the key because the user removed
// this device, Stderr gets one line that says so and how to make a new
// key. Later runs read the refusal from the record and stay quiet.
func PrepareIrohRoute(setup IrohSetup, transport ProxyTransport, events *slog.Logger) (*IrohRoute, string, error) {
	if transport == TransportDirectWS {
		return nil, "", nil
	}
	route, reason, err := prepareIrohRoute(setup)
	if err == nil {
		return route, "", nil
	}
	events.Info("iroh_unavailable", slog.String("reason", reason), slog.String("error", err.Error()))
	var refused *amikanet.RefusedError
	if errors.As(err, &refused) && refused.Fresh && errors.Is(err, amikanet.ErrKeyRevoked) && setup.Stderr != nil {
		_, _ = fmt.Fprintln(setup.Stderr, "amika: this device's amika-net key was removed from your Amika account. To use iroh again, make a new key with: amika rig --new-device-key ssh <rig>")
	}
	if transport == TransportIroh {
		return nil, "", fmt.Errorf("--transport iroh: %w", err)
	}
	return nil, "iroh unavailable: " + err.Error(), nil
}

func prepareIrohRoute(setup IrohSetup) (*IrohRoute, string, error) {
	find := setup.FindBinary
	if find == nil {
		find = amikanet.FindBinary
	}
	binary, err := find()
	if err != nil {
		return nil, "amika_net_missing", err
	}
	keyFile, err := amikanet.DeviceKeyFile(setup.Paths)
	if err != nil {
		return nil, "device_key", err
	}
	key, err := amikanet.LoadOrCreateDeviceKey(keyFile)
	if err != nil {
		return nil, "device_key", err
	}
	registrations, err := amikanet.OpenRegistrations(setup.Paths)
	if err != nil {
		return nil, "device_registration", err
	}
	if _, err := registrations.Ensure(setup.Account, setup.Registrar, key); err != nil {
		if errors.Is(err, amikanet.ErrKeyTaken) {
			return nil, "device_key_taken", err
		}
		if errors.Is(err, amikanet.ErrKeyRevoked) {
			return nil, "device_revoked", err
		}
		return nil, "device_registration", err
	}
	return &IrohRoute{
		Binary:  binary,
		KeyFile: keyFile,
		Forget:  func() { _ = registrations.Forget(setup.Account) },
	}, "", nil
}

// irohDialError is an iroh dial that failed before its WebSocket opened:
// amika-net did not start, could not reach the host, or the host refused
// the stream. Reason never holds a key, a token or a session secret.
type irohDialError struct{ Reason string }

func (e *irohDialError) Error() string { return "SSH over iroh failed: " + e.Reason }

// irohDialer reaches amikad through one `amika-net connect` process per
// dial, and runs the same WebSocket client as direct_ws over the process's
// stdin and stdout. So each resume runs over a new connect process.
type irohDialer struct {
	route  IrohRoute
	target apiclient.SSHSessionIroh
}

// connectArgs is the `amika-net connect` argv from the contract. The
// caller has checked that the descriptor has a relay URL.
func (d irohDialer) connectArgs() []string {
	return []string{
		"connect",
		"--key-file", d.route.KeyFile,
		"--endpoint", d.target.EndpointID,
		"--relay-url", *d.target.RelayURL,
		"--target", "rig:" + d.target.RigID + ":" + strconv.Itoa(d.target.Port),
	}
}

// DialTransport opens one frame transport to amikad's resumable route over
// a new connect process.
func (d irohDialer) DialTransport(ctx context.Context, connectURL, credential string) (sshresume.Transport, error) {
	connection, err := d.handshake(ctx, connectURL, credential)
	if err != nil {
		return nil, err
	}
	return sshresume.NewWebSocketTransport(connection), nil
}

// Dial opens one byte stream to amikad's /v1 route over a new connect
// process.
func (d irohDialer) Dial(ctx context.Context, connectURL, credential string) (Stream, error) {
	dialCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	connection, err := d.handshake(dialCtx, connectURL, credential)
	if err != nil {
		return nil, err
	}
	return wsstream.New(ctx, connection, 64*1024), nil
}

// handshake starts a connect process and upgrades to a WebSocket over it.
// The stream ends at amikad itself, so the request names amikad's own route
// with no TLS: the iroh connection is already encrypted end to end.
func (d irohDialer) handshake(ctx context.Context, connectURL, credential string) (*websocket.Conn, error) {
	wsURL, err := irohWebSocketURL(connectURL)
	if err != nil {
		return nil, err
	}
	process, err := startConnectProcess(d.route.Binary, d.connectArgs())
	if err != nil {
		return nil, &irohDialError{Reason: "could not start amika-net"}
	}
	header := make(http.Header)
	header.Set("Authorization", "Bearer "+credential)
	client := &http.Client{Transport: &http.Transport{
		DialContext:       process.take,
		DisableKeepAlives: true,
	}}
	connection, response, err := websocket.Dial(ctx, wsURL, &websocket.DialOptions{
		HTTPClient:      client,
		HTTPHeader:      header,
		CompressionMode: websocket.CompressionDisabled,
	})
	if err == nil {
		return connection, nil
	}
	// amikad answered with a status, so the iroh path works: the caller
	// treats it as it treats the same answer over direct_ws.
	if response != nil {
		_ = process.Close()
		return nil, &DialStatusError{StatusCode: response.StatusCode}
	}
	reason := process.failure(ctx)
	_ = process.Close()
	return nil, &irohDialError{Reason: reason}
}

// irohWebSocketURL is the descriptor's route with amikad's own path: the
// connect URL may carry a gateway's path prefix, which the iroh stream
// skips.
func irohWebSocketURL(connectURL string) (string, error) {
	parsed, err := url.Parse(connectURL)
	if err != nil || parsed.Host == "" {
		return "", errors.New("invalid SSH connect URL")
	}
	for _, suffix := range []string{v1SessionsSuffix, v2SessionsSuffix} {
		if strings.HasSuffix(parsed.EscapedPath(), suffix) {
			return "ws://" + parsed.Host + suffix, nil
		}
	}
	return "", errors.New("invalid SSH connect URL")
}

// connectProcess is one `amika-net connect` child. It is the net.Conn the
// HTTP client dials: its stdin and stdout are the stream to amikad.
type connectProcess struct {
	cmd    *exec.Cmd
	stdin  *os.File
	stdout *os.File
	stderr *tailBuffer
	exited chan struct{}
	// waitErr is set before exited closes.
	waitErr error

	mu        sync.Mutex
	taken     bool
	closeOnce sync.Once
}

// connectExitWait is how long Close lets the process end on its own, after
// its stdin closes, before it kills it.
const connectExitWait = 2 * time.Second

// startConnectProcess starts amika-net with its own pipes. They are not
// exec's StdoutPipe: Wait closes those as the process exits, and the last
// bytes amikad sent, such as its GOODBYE, would be lost.
func startConnectProcess(binary string, args []string) (*connectProcess, error) {
	stdinRead, stdinWrite, err := os.Pipe()
	if err != nil {
		return nil, err
	}
	stdoutRead, stdoutWrite, err := os.Pipe()
	if err != nil {
		_ = stdinRead.Close()
		_ = stdinWrite.Close()
		return nil, err
	}
	process := &connectProcess{
		cmd:    exec.Command(binary, args...),
		stdin:  stdinWrite,
		stdout: stdoutRead,
		stderr: &tailBuffer{},
		exited: make(chan struct{}),
	}
	process.cmd.Stdin = stdinRead
	process.cmd.Stdout = stdoutWrite
	process.cmd.Stderr = process.stderr
	err = process.cmd.Start()
	_ = stdinRead.Close()
	_ = stdoutWrite.Close()
	if err != nil {
		_ = stdinWrite.Close()
		_ = stdoutRead.Close()
		return nil, err
	}
	go func() {
		process.waitErr = process.cmd.Wait()
		close(process.exited)
	}()
	return process, nil
}

// take hands the process to the HTTP client, once.
func (p *connectProcess) take(context.Context, string, string) (net.Conn, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.taken {
		return nil, errors.New("the amika-net stream is already in use")
	}
	p.taken = true
	return p, nil
}

// failure says why the handshake got no answer, after the process has had
// a moment to exit and report.
func (p *connectProcess) failure(ctx context.Context) string {
	if ctx.Err() != nil {
		return "no answer over iroh before the dial timeout"
	}
	select {
	case <-p.exited:
	case <-time.After(time.Second):
		return "the iroh stream closed before the WebSocket opened"
	}
	reason := "amika-net connect exited"
	if p.waitErr != nil {
		reason += " (" + p.waitErr.Error() + ")"
	}
	if line := p.stderr.lastLine(); line != "" {
		reason += ": " + line
	}
	return reason
}

func (p *connectProcess) Read(b []byte) (int, error)  { return p.stdout.Read(b) }
func (p *connectProcess) Write(b []byte) (int, error) { return p.stdin.Write(b) }

// Close ends the stream: amika-net sees its stdin end and finishes, or is
// killed after connectExitWait.
func (p *connectProcess) Close() error {
	p.closeOnce.Do(func() {
		_ = p.stdin.Close()
		_ = p.stdout.Close()
		go func() {
			select {
			case <-p.exited:
			case <-time.After(connectExitWait):
				_ = p.cmd.Process.Kill()
			}
		}()
	})
	return nil
}

func (p *connectProcess) LocalAddr() net.Addr              { return connectAddr{} }
func (p *connectProcess) RemoteAddr() net.Addr             { return connectAddr{} }
func (p *connectProcess) SetDeadline(time.Time) error      { return nil }
func (p *connectProcess) SetReadDeadline(time.Time) error  { return nil }
func (p *connectProcess) SetWriteDeadline(time.Time) error { return nil }
func (connectAddr) Network() string                        { return amikanet.BinaryName }
func (connectAddr) String() string                         { return amikanet.BinaryName }

type connectAddr struct{}

// tailBuffer keeps the last bytes amika-net wrote to stderr, for the
// failure reason.
type tailBuffer struct {
	mu  sync.Mutex
	buf []byte
}

const tailBufferBytes = 4096

func (b *tailBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.buf = append(b.buf, p...)
	if len(b.buf) > tailBufferBytes {
		b.buf = b.buf[len(b.buf)-tailBufferBytes:]
	}
	return len(p), nil
}

// lastLine is the last non-empty line, as printable ASCII, cut to 300
// bytes.
func (b *tailBuffer) lastLine() string {
	b.mu.Lock()
	text := string(b.buf)
	b.mu.Unlock()
	lines := strings.Split(strings.TrimSpace(text), "\n")
	var out strings.Builder
	for _, r := range lines[len(lines)-1] {
		if out.Len() >= 300 {
			break
		}
		if r >= 0x20 && r < 0x7f {
			out.WriteRune(r)
		}
	}
	return strings.TrimSpace(out.String())
}

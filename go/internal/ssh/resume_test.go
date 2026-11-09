package ssh

import (
	"bytes"
	"context"
	"crypto/ed25519"
	cryptorand "crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"io"
	"log/slog"
	"math/rand/v2"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gofixpoint/amika/go/internal/amikad/norelay"
	"github.com/gofixpoint/amika/go/internal/apiclient"
	"github.com/gofixpoint/amika/go/internal/sshresume"
	"github.com/gofixpoint/amika/go/internal/sshresume/resumetest"
	cryptossh "golang.org/x/crypto/ssh"
)

// testRig is amikad's real handler, reached through in-memory pipes. Each
// sshd dial gives the test the other end of a net.Pipe.
type testRig struct {
	t        *testing.T
	handler  *norelay.Handler
	upgrades chan *resumetest.End
	sshd     chan net.Conn
	sshdDial atomic.Int32
	dials    atomic.Int32
	logs     *lockedBuffer
	// fault picks each transport's fault.
	fault func() resumetest.Fault
	// refuse, if set, can fail a dial before it reaches amikad.
	refuse func(dial int) error
	ends   []*resumetest.End
	endsMu sync.Mutex
}

type lockedBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *lockedBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *lockedBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

type rigVerifier struct{}

func (rigVerifier) Verify(token string) bool { return token == testConnectToken() }

type rigSSHDDialer struct{ rig *testRig }

func (d rigSSHDDialer) DialContext(context.Context, string, string) (norelay.Stream, error) {
	d.rig.sshdDial.Add(1)
	amikad, sshd := net.Pipe()
	d.rig.sshd <- sshd
	return amikad, nil
}

type pipeFrameUpgrader struct{ rig *testRig }

func (u pipeFrameUpgrader) UpgradeTransport(http.ResponseWriter, *http.Request) (sshresume.Transport, error) {
	return <-u.rig.upgrades, nil
}

func newTestRig(t *testing.T, timing sshresume.Timing) *testRig {
	t.Helper()
	rig := &testRig{
		t:        t,
		upgrades: make(chan *resumetest.End, 1),
		sshd:     make(chan net.Conn, 16),
		logs:     &lockedBuffer{},
		fault:    func() resumetest.Fault { return resumetest.NoFault },
	}
	rig.handler = norelay.NewHandler(norelay.Config{ResumeTiming: timing}, norelay.Dependencies{
		Verifier:      rigVerifier{},
		FrameUpgrader: pipeFrameUpgrader{rig: rig},
		Dialer:        rigSSHDDialer{rig: rig},
		Logger:        slog.New(slog.NewJSONHandler(rig.logs, nil)),
	})
	t.Cleanup(rig.handler.Close)
	return rig
}

// DialTransport opens a pipe to amikad's /v2 handler.
func (r *testRig) DialTransport(_ context.Context, _, credential string) (sshresume.Transport, error) {
	dial := int(r.dials.Add(1))
	if r.refuse != nil {
		if err := r.refuse(dial); err != nil {
			return nil, err
		}
	}
	client, server := resumetest.Pipe(r.fault())
	r.endsMu.Lock()
	r.ends = append(r.ends, client)
	r.endsMu.Unlock()
	r.upgrades <- server
	request := httptest.NewRequest(http.MethodGet, norelay.ResumableSSHSessionsPath, nil)
	request.Header.Set("Authorization", "Bearer "+credential)
	go r.handler.ServeHTTP(httptest.NewRecorder(), request)
	return client, nil
}

// Dial is the /v1 route, which these tests never reach.
func (r *testRig) Dial(context.Context, string, string) (Stream, error) {
	r.t.Error("the proxy fell back to /v1")
	return nil, errors.New("no /v1 here")
}

// cutCurrent cuts the newest transport, as a dropped connection does.
func (r *testRig) cutCurrent() {
	r.endsMu.Lock()
	defer r.endsMu.Unlock()
	r.ends[len(r.ends)-1].Cut()
}

func (r *testRig) nextSSHD() net.Conn {
	r.t.Helper()
	select {
	case conn := <-r.sshd:
		r.t.Cleanup(func() { conn.Close() })
		return conn
	case <-time.After(5 * time.Second):
		r.t.Fatal("amikad did not dial sshd")
		return nil
	}
}

func fastResumeTiming() sshresume.Timing {
	return sshresume.Timing{
		AckDelay:     time.Millisecond,
		PingInterval: 30 * time.Millisecond,
		DeadAfter:    200 * time.Millisecond,
		ResumeGrace:  10 * time.Second,
	}
}

// startProxy runs the resumable proxy against rig on an in-memory pipe for
// OpenSSH's standard I/O, and returns OpenSSH's end and the proxy's result.
func startProxy(t *testing.T, rig *testRig, configure func(*resumeProxy)) (net.Conn, <-chan error, *lockedBuffer) {
	t.Helper()
	events := &lockedBuffer{}
	proxy := newResumeProxy(rig, "wss://rig.example/v2/ssh-sessions", testConnectToken(), slog.New(slog.NewJSONHandler(events, nil)))
	proxy.timing = fastResumeTiming().WithDefaults()
	proxy.jitter = func(d time.Duration) time.Duration { return d }
	if configure != nil {
		configure(proxy)
	}
	proxyEnd, opensshEnd := net.Pipe()
	result := make(chan error, 1)
	go func() { result <- proxy.run(context.Background(), proxyEnd, proxyEnd) }()
	t.Cleanup(func() { opensshEnd.Close() })
	return opensshEnd, result, events
}

// waitOpen waits until the proxy has its session: amikad dials sshd before it
// sends WELCOME, so a fault injected earlier would hit the first dial.
func waitOpen(t *testing.T, events *lockedBuffer) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !strings.Contains(events.String(), `"msg":"ssh_bridge_open"`) {
		if time.Now().After(deadline) {
			t.Fatal("the proxy did not open a session")
		}
		time.Sleep(time.Millisecond)
	}
}

// restart replaces amikad with a fresh one that knows no session, as a rig
// restart does.
func (r *testRig) restart() {
	r.handler.Close()
	r.handler = norelay.NewHandler(norelay.Config{ResumeTiming: fastResumeTiming()}, norelay.Dependencies{
		Verifier:      rigVerifier{},
		FrameUpgrader: pipeFrameUpgrader{rig: r},
		Dialer:        rigSSHDDialer{rig: r},
		Logger:        slog.New(slog.NewJSONHandler(r.logs, nil)),
	})
	r.t.Cleanup(r.handler.Close)
}

func waitResult(t *testing.T, result <-chan error) error {
	t.Helper()
	select {
	case err := <-result:
		return err
	case <-time.After(15 * time.Second):
		t.Fatal("the proxy did not exit")
		return nil
	}
}

func exitCodeOf(err error) int {
	var exit *ProxyExitError
	if errors.As(err, &exit) {
		return exit.Code
	}
	if err != nil {
		return 1
	}
	return 0
}

func readN(t *testing.T, conn net.Conn, n int) []byte {
	t.Helper()
	_ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	buffer := make([]byte, n)
	if _, err := io.ReadFull(conn, buffer); err != nil {
		t.Fatalf("read: %v", err)
	}
	return buffer
}

// P-A2-1, in process: a dropped transport resumes, and OpenSSH sees only a
// pause. The same sshd connection carries on.
func TestResumeProxyResumesAfterADrop(t *testing.T) {
	rig := newTestRig(t, fastResumeTiming())
	openssh, result, events := startProxy(t, rig, nil)
	sshd := rig.nextSSHD()
	waitOpen(t, events)

	if _, err := openssh.Write([]byte("before")); err != nil {
		t.Fatal(err)
	}
	readN(t, sshd, 6)
	rig.cutCurrent()
	if _, err := sshd.Write([]byte("while-cut")); err != nil {
		t.Fatal(err)
	}
	if _, err := openssh.Write([]byte("after")); err != nil {
		t.Fatal(err)
	}
	if got := readN(t, openssh, 9); string(got) != "while-cut" {
		t.Fatalf("OpenSSH read %q", got)
	}
	if got := readN(t, sshd, 5); string(got) != "after" {
		t.Fatalf("sshd read %q", got)
	}
	if rig.dials.Load() < 2 || rig.sshdDial.Load() != 1 {
		t.Fatalf("dials = %d, sshd dials = %d", rig.dials.Load(), rig.sshdDial.Load())
	}
	openssh.Close()
	if err := waitResult(t, result); err != nil {
		t.Fatalf("proxy exit = %v, want 0 after stdin ends", err)
	}
}

// P-A2-6: sshd ends; the rig's GOODBYE arrives with every byte; exit 0.
func TestResumeProxyExitsZeroOnTheRigsGoodbye(t *testing.T) {
	rig := newTestRig(t, fastResumeTiming())
	openssh, result, _ := startProxy(t, rig, nil)
	sshd := rig.nextSSHD()
	if _, err := sshd.Write([]byte("last words")); err != nil {
		t.Fatal(err)
	}
	sshd.Close()
	if got := readN(t, openssh, 10); string(got) != "last words" {
		t.Fatalf("OpenSSH read %q", got)
	}
	if err := waitResult(t, result); err != nil {
		t.Fatalf("proxy exit = %v", err)
	}
	if _, err := openssh.Read(make([]byte, 1)); err == nil {
		t.Fatal("stdout stayed open after the session ended")
	}
}

func TestResumeProxyExits255OnTheRigsAbort(t *testing.T) {
	rig := newTestRig(t, fastResumeTiming())
	_, result, events := startProxy(t, rig, nil)
	rig.nextSSHD()
	waitOpen(t, events)
	rig.handler.Close()
	if err := waitResult(t, result); exitCodeOf(err) != 255 {
		t.Fatalf("proxy exit = %v, want 255", err)
	}
}

// The design's exit table, for a drop the proxy cannot resume.
func TestResumeProxyExitTable(t *testing.T) {
	for name, tc := range map[string]struct {
		// restart: amikad restarts while the transport is down, so the
		// resume finds no session.
		restart     bool
		refuse      func() error
		closeStdin  bool
		wantCode    int
		wantRefusal string
	}{
		"unknown session": {restart: true, wantCode: 255, wantRefusal: "unknown"},
		"unknown session after stdin ended": {
			restart: true, closeStdin: true, wantCode: 0, wantRefusal: "unknown",
		},
		"connect token rotated": {
			refuse:   func() error { return &DialStatusError{StatusCode: http.StatusUnauthorized} },
			wantCode: 255, wantRefusal: "token_rotated",
		},
		"route gone": {
			refuse:   func() error { return &DialStatusError{StatusCode: http.StatusNotFound} },
			wantCode: 255, wantRefusal: "route_gone",
		},
	} {
		t.Run(name, func(t *testing.T) {
			rig := newTestRig(t, fastResumeTiming())
			openssh, result, events := startProxy(t, rig, nil)
			rig.nextSSHD()
			waitOpen(t, events)
			var down atomic.Bool
			down.Store(true)
			rig.refuse = func(int) error {
				if down.Load() {
					return errors.New("network down")
				}
				if tc.refuse != nil {
					return tc.refuse()
				}
				return nil
			}
			rig.cutCurrent()
			if tc.closeStdin {
				openssh.Close()
			}
			if tc.restart {
				rig.restart()
			}
			down.Store(false)
			err := waitResult(t, result)
			if code := exitCodeOf(err); code != tc.wantCode {
				t.Fatalf("exit = %d (%v), want %d", code, err, tc.wantCode)
			}
			if tc.wantRefusal != "" && !strings.Contains(events.String(), `"reason":"`+tc.wantRefusal+`"`) {
				t.Fatalf("events lack refusal %q:\n%s", tc.wantRefusal, events.String())
			}
		})
	}
}

// P-A2-4: a cut longer than the grace period ends the proxy with 255 at the
// grace period, with one line for stderr.
func TestResumeProxyGivesUpAtTheGracePeriod(t *testing.T) {
	rig := newTestRig(t, fastResumeTiming())
	clock := resumetest.NewFakeClock()
	_, result, events := startProxy(t, rig, func(p *resumeProxy) { p.clock = clock })
	rig.nextSSHD()
	waitOpen(t, events)
	rig.refuse = func(int) error { return errors.New("network down") }
	rig.cutCurrent()

	grace := fastResumeTiming().ResumeGrace
	for elapsed := time.Duration(0); ; elapsed += 250 * time.Millisecond {
		select {
		case err := <-result:
			if exitCodeOf(err) != 255 || strings.Contains(err.Error(), "\n") {
				t.Fatalf("exit = %v, want 255 with one line", err)
			}
			if elapsed < grace-time.Second || elapsed > grace+time.Second {
				t.Fatalf("gave up after %s, want about %s", elapsed, grace)
			}
			if !strings.Contains(events.String(), "ssh_bridge_close") {
				t.Fatalf("no close event:\n%s", events.String())
			}
			return
		case <-time.After(5 * time.Millisecond):
		}
		if elapsed > 2*grace {
			t.Fatal("the proxy never gave up")
		}
		clock.Advance(250 * time.Millisecond)
	}
}

// stdin's EOF sends GOODBYE; with no ACK within goodbyeWait, across a
// resume, the proxy still exits 0, because OpenSSH has already closed its
// side.
func TestResumeProxyWaitsAtMostGoodbyeWaitAfterStdinEnds(t *testing.T) {
	rig := newTestRig(t, fastResumeTiming())
	clock := resumetest.NewFakeClock()
	openssh, result, events := startProxy(t, rig, func(p *resumeProxy) { p.clock = clock })
	rig.nextSSHD()
	waitOpen(t, events)
	rig.refuse = func(int) error { return errors.New("network down") }
	rig.cutCurrent()
	openssh.Close()
	for elapsed := time.Duration(0); ; elapsed += 50 * time.Millisecond {
		select {
		case err := <-result:
			if err != nil {
				t.Fatalf("exit = %v, want 0", err)
			}
			if elapsed > goodbyeWait {
				t.Fatalf("exited after %s, want at most %s", elapsed, goodbyeWait)
			}
			return
		case <-time.After(5 * time.Millisecond):
		}
		if elapsed > 2*goodbyeWait {
			t.Fatal("the proxy kept waiting after stdin ended")
		}
		clock.Advance(50 * time.Millisecond)
	}
}

// stdin can end while the proxy is already resuming. The goodbye deadline
// still applies: the proxy must not try for the whole grace period after
// OpenSSH has gone.
func TestResumeProxyStopsResumingSoonAfterStdinEnds(t *testing.T) {
	rig := newTestRig(t, fastResumeTiming())
	clock := resumetest.NewFakeClock()
	openssh, result, events := startProxy(t, rig, func(p *resumeProxy) { p.clock = clock })
	rig.nextSSHD()
	waitOpen(t, events)
	rig.refuse = func(int) error { return errors.New("network down") }
	rig.cutCurrent()
	deadline := time.Now().Add(5 * time.Second)
	for !strings.Contains(events.String(), "ssh_resume_detach") {
		if time.Now().After(deadline) {
			t.Fatal("the proxy did not start resuming")
		}
		time.Sleep(time.Millisecond)
	}
	clock.Advance(time.Second)
	openssh.Close()
	time.Sleep(20 * time.Millisecond)
	for elapsed := time.Duration(0); ; elapsed += 50 * time.Millisecond {
		select {
		case err := <-result:
			if err != nil {
				t.Fatalf("exit = %v, want 0", err)
			}
			if elapsed > goodbyeWait+50*time.Millisecond {
				t.Fatalf("exited %s after stdin ended, want at most %s", elapsed, goodbyeWait)
			}
			return
		case <-time.After(5 * time.Millisecond):
		}
		if elapsed > 3*goodbyeWait {
			t.Fatal("the proxy kept resuming after stdin ended")
		}
		clock.Advance(50 * time.Millisecond)
	}
}

func TestResumeProxyReportsABusyRig(t *testing.T) {
	rig := newTestRig(t, fastResumeTiming())
	rig.handler = norelay.NewHandler(norelay.Config{MaxConnections: 1}, norelay.Dependencies{
		Verifier:      rigVerifier{},
		FrameUpgrader: pipeFrameUpgrader{rig: rig},
		Dialer:        rigSSHDDialer{rig: rig},
	})
	t.Cleanup(rig.handler.Close)
	startProxy(t, rig, nil)
	rig.nextSSHD()
	_, result, _ := startProxy(t, rig, nil)
	if err := waitResult(t, result); err == nil || errors.Is(err, errResumeUnsupported) {
		t.Fatalf("second session error = %v", err)
	}
}

// P-A2-9: an amikad or hostd from before resume answers 404 or 401 at /v2;
// ssh_resume false skips /v2. Each uses /v1.
func TestProxySessionFallsBackToV1(t *testing.T) {
	disabled := false
	for name, tc := range map[string]struct {
		status    int
		resume    *bool
		wantV2Try bool
	}{
		"old amikad":            {status: http.StatusNotFound, wantV2Try: true},
		"old hostd gateway":     {status: http.StatusUnauthorized, wantV2Try: true},
		"descriptor switch off": {resume: &disabled},
	} {
		t.Run(name, func(t *testing.T) {
			creator := &fakeCreator{hostKey: testHostKey(t), resume: tc.resume}
			stream := &proxyStream{read: bytes.NewReader([]byte("from-sshd"))}
			dialer := &statusDialer{status: tc.status, v1: &fakeSessionDialer{stream: stream}}
			var stdout bytes.Buffer
			err := ProxySession(context.Background(), creator, dialer, &fakePinStore{}, "my.team.sbx_123.localhost-3011.amika", strings.NewReader("x"), &stdout, nil)
			if err != nil {
				t.Fatalf("ProxySession: %v", err)
			}
			if (dialer.v2Calls > 0) != tc.wantV2Try || dialer.v1.calls != 1 {
				t.Fatalf("v2 dials = %d, v1 dials = %d", dialer.v2Calls, dialer.v1.calls)
			}
			if stdout.String() != "from-sshd" {
				t.Fatalf("stdout = %q", stdout.String())
			}
		})
	}
}

type statusDialer struct {
	status  int
	v2Calls int
	v1      *fakeSessionDialer
}

func (d *statusDialer) DialTransport(context.Context, string, string) (sshresume.Transport, error) {
	d.v2Calls++
	return nil, &DialStatusError{StatusCode: d.status}
}

func (d *statusDialer) Dial(ctx context.Context, url, credential string) (Stream, error) {
	return d.v1.Dial(ctx, url, credential)
}

func TestResumeURLReplacesOnlyTheRouteSuffix(t *testing.T) {
	for in, want := range map[string]string{
		"wss://sandbox.example/v1/ssh-sessions":                                  "wss://sandbox.example/v2/ssh-sessions",
		"wss://h.example/base/v0beta1/rigs/demo/services/amikad/v1/ssh-sessions": "wss://h.example/base/v0beta1/rigs/demo/services/amikad/v2/ssh-sessions",
	} {
		if got, ok := resumeURL(in); !ok || got != want {
			t.Errorf("resumeURL(%q) = %q, %v", in, got, ok)
		}
	}
	if _, ok := resumeURL("wss://sandbox.example/v1/other"); ok {
		t.Error("a URL without the /v1 route was accepted")
	}
}

func TestExitForFollowsTheDesignTable(t *testing.T) {
	goodbyeIn := sshresume.End{Kind: sshresume.EndGoodbyeReceived}
	goodbyeOut := sshresume.End{Kind: sshresume.EndGoodbyeAcked}
	abort := sshresume.End{Kind: sshresume.EndAbortReceived, Reason: sshresume.AbortShutdown}
	expired := sshresume.End{Kind: sshresume.EndExpired}
	for name, tc := range map[string]struct {
		outcome    resumeOutcome
		end        sshresume.End
		stdinEnded bool
		want       int
	}{
		"own GOODBYE acknowledged":    {end: goodbyeOut, want: 0},
		"rig GOODBYE with every byte": {end: goodbyeIn, want: 0},
		"stdin ended, then unknown":   {outcome: outcomeUnknown, end: expired, stdinEnded: true, want: 0},
		"stdin ended, ACK never came": {outcome: outcomeStdinDone, end: expired, stdinEnded: true, want: 0},
		"unknown without either":      {outcome: outcomeUnknown, end: expired, want: 255},
		"abort received":              {end: abort, want: 255},
		"grace passed":                {outcome: outcomeGaveUp, end: expired, want: 255},
		"token rotated":               {outcome: outcomeTokenRotated, end: expired, want: 255},
		"protocol error":              {outcome: outcomeProtocol, end: expired, want: 255},
	} {
		exit := exitFor(tc.outcome, tc.end, tc.stdinEnded, time.Minute)
		got := 0
		if exit != nil {
			got = exit.Code
		}
		if got != tc.want {
			t.Errorf("%s: exit %d, want %d", name, got, tc.want)
		}
	}
}

// The proxy's event log names the session by its ref; it never holds the
// secret, the connect token or session bytes.
func TestResumeProxyEventsHoldNoSecrets(t *testing.T) {
	rig := newTestRig(t, fastResumeTiming())
	openssh, result, events := startProxy(t, rig, nil)
	sshd := rig.nextSSHD()
	waitOpen(t, events)
	if _, err := openssh.Write([]byte("private-session-bytes")); err != nil {
		t.Fatal(err)
	}
	readN(t, sshd, len("private-session-bytes"))
	rig.cutCurrent()
	if _, err := sshd.Write([]byte("x")); err != nil {
		t.Fatal(err)
	}
	readN(t, openssh, 1)
	openssh.Close()
	waitResult(t, result)

	logs := events.String() + rig.logs.String()
	for _, forbidden := range []string{testConnectToken(), "private-session-bytes"} {
		if strings.Contains(logs, forbidden) {
			t.Fatalf("logs hold %q", forbidden)
		}
	}
	for _, line := range strings.Split(logs, "\n") {
		for _, field := range strings.Fields(strings.NewReplacer(`"`, " ", ",", " ", ":", " ").Replace(line)) {
			if len(field) >= 43 {
				if _, err := base64.RawURLEncoding.DecodeString(field); err == nil {
					t.Fatalf("log line holds a long credential-like value: %s", line)
				}
				if _, err := hex.DecodeString(field); err == nil {
					t.Fatalf("log line holds a long hex value: %s", line)
				}
			}
		}
	}
	for _, message := range []string{"ssh_bridge_open", "ssh_resume_detach", "ssh_resume_attach", "ssh_bridge_close"} {
		if !strings.Contains(events.String(), `"msg":"`+message+`"`) {
			t.Fatalf("proxy events lack %s:\n%s", message, events.String())
		}
	}
}

// The end-to-end property, in process: an x/crypto/ssh client and server at
// the two ends, the real proxy and amikad between them, and transports that
// cut at random bytes or go silent. Every byte through an SSH channel comes
// back exactly once and in order, over one sshd connection.
func TestResumeProxyCarriesAnSSHSessionAcrossRandomFaults(t *testing.T) {
	seeds := 16
	if testing.Short() {
		seeds = 4
	}
	transports := 0
	for seed := range uint64(seeds) {
		transports += runSSHAcrossFaults(t, seed)
	}
	if transports < 2*seeds {
		t.Fatalf("%d sessions used only %d transports; the faults did not fire", seeds, transports)
	}
}

// runSSHAcrossFaults runs one session and returns how many transports it
// used.
func runSSHAcrossFaults(t *testing.T, seed uint64) int {
	rng := rand.New(rand.NewPCG(seed, 0xfa))
	var rngMu sync.Mutex
	rig := newTestRig(t, fastResumeTiming())
	rig.fault = func() resumetest.Fault {
		rngMu.Lock()
		defer rngMu.Unlock()
		fault := resumetest.NoFault
		switch rng.IntN(10) {
		case 0, 1, 2:
			fault.CutAt = rng.Int64N(2048)
		case 3, 4, 5, 6, 7:
			fault.CutAt = rng.Int64N(256 << 10)
		case 8:
			fault.SilentAt = rng.Int64N(256 << 10)
		}
		return fault
	}
	openssh, result, _ := startProxy(t, rig, nil)
	hostKey := newHostSigner(t)
	go serveEchoSSH(rig.nextSSHD(), hostKey)

	connection, channels, requests, err := cryptossh.NewClientConn(openssh, "rig", &cryptossh.ClientConfig{
		User:            "amika",
		HostKeyCallback: cryptossh.FixedHostKey(hostKey.PublicKey()),
		Timeout:         10 * time.Second,
	})
	if err != nil {
		t.Fatalf("seed %d: SSH handshake: %v", seed, err)
	}
	client := cryptossh.NewClient(connection, channels, requests)
	channel, channelRequests, err := client.OpenChannel("echo", nil)
	if err != nil {
		t.Fatalf("seed %d: open channel: %v", seed, err)
	}
	go cryptossh.DiscardRequests(channelRequests)

	payload := make([]byte, 1<<20+rng.IntN(1<<20))
	for i := range payload {
		payload[i] = byte(rng.Uint32())
	}
	writes := rand.New(rand.NewPCG(seed, 0x77))
	go func() {
		for chunk := payload; len(chunk) > 0; {
			n := min(len(chunk), 1+writes.IntN(16<<10))
			if _, err := channel.Write(chunk[:n]); err != nil {
				return
			}
			chunk = chunk[n:]
		}
		_ = channel.CloseWrite()
	}()
	echoed, err := io.ReadAll(channel)
	if err != nil {
		t.Fatalf("seed %d: read echo: %v", seed, err)
	}
	if !bytes.Equal(echoed, payload) {
		t.Fatalf("seed %d: echoed %d bytes, sent %d; the stream differs", seed, len(echoed), len(payload))
	}
	_ = client.Close()
	if err := waitResult(t, result); exitCodeOf(err) != 0 {
		t.Fatalf("seed %d: proxy exit = %v", seed, err)
	}
	if rig.sshdDial.Load() != 1 {
		t.Fatalf("seed %d: amikad dialed sshd %d times, want 1", seed, rig.sshdDial.Load())
	}
	t.Logf("seed %d: %d transports for %d bytes each way", seed, rig.dials.Load(), len(payload))
	return int(rig.dials.Load())
}

func newHostSigner(t *testing.T) cryptossh.Signer {
	t.Helper()
	_, private, err := ed25519.GenerateKey(cryptorand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	signer, err := cryptossh.NewSignerFromKey(private)
	if err != nil {
		t.Fatal(err)
	}
	return signer
}

// serveEchoSSH is sshd for the tests: one SSH server connection whose "echo"
// channels send back every byte they receive.
func serveEchoSSH(conn net.Conn, hostKey cryptossh.Signer) {
	config := &cryptossh.ServerConfig{NoClientAuth: true}
	config.AddHostKey(hostKey)
	_, channels, requests, err := cryptossh.NewServerConn(conn, config)
	if err != nil {
		return
	}
	go cryptossh.DiscardRequests(requests)
	for newChannel := range channels {
		if newChannel.ChannelType() != "echo" {
			_ = newChannel.Reject(cryptossh.UnknownChannelType, "echo only")
			continue
		}
		channel, channelRequests, err := newChannel.Accept()
		if err != nil {
			continue
		}
		go cryptossh.DiscardRequests(channelRequests)
		go func() {
			_, _ = io.Copy(channel, channel)
			_ = channel.CloseWrite()
		}()
	}
}

// urlCreator hands out a descriptor for a test server's URL.
type urlCreator struct {
	connectURL string
	hostKey    string
}

func (c urlCreator) CreateSSHSession(id string) (*apiclient.SSHSession, error) {
	return &apiclient.SSHSession{
		SessionID:         "sshs_1",
		Transport:         apiclient.SSHSessionTransportDirectWS,
		ConnectURL:        c.connectURL,
		ConnectCredential: testConnectToken(),
		SandboxID:         id,
		SSHUser:           apiclient.DefaultSSHUser,
		HostPublicKey:     c.hostKey,
	}, nil
}

// cuttingDialer closes each real WebSocket after a few hundred KiB, the way
// a dropped connection ends one.
type cuttingDialer struct {
	WebSocketDialer
	budgets chan int64
}

func (d cuttingDialer) DialTransport(ctx context.Context, url, credential string) (sshresume.Transport, error) {
	transport, err := d.WebSocketDialer.DialTransport(ctx, url, credential)
	if err != nil {
		return nil, err
	}
	budget := int64(-1)
	select {
	case budget = <-d.budgets:
	default:
	}
	return &cuttingTransport{Transport: transport, budget: budget}, nil
}

type cuttingTransport struct {
	sshresume.Transport
	mu     sync.Mutex
	budget int64
}

func (t *cuttingTransport) spend(n int) error {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.budget < 0 {
		return nil
	}
	t.budget -= int64(n)
	if t.budget < 0 {
		go t.Transport.Close(1001)
		return errors.New("cut")
	}
	return nil
}

func (t *cuttingTransport) WriteFrame(frame []byte) error {
	if err := t.spend(len(frame)); err != nil {
		return err
	}
	return t.Transport.WriteFrame(frame)
}

func (t *cuttingTransport) ReadFrame() ([]byte, error) {
	frame, err := t.Transport.ReadFrame()
	if err == nil {
		err = t.spend(len(frame))
	}
	return frame, err
}

// An SSH session through ProxySession, the real WebSocket dialer and amikad's
// real routes over TLS, with each WebSocket cut after a few hundred KiB.
func TestProxySessionResumesOverRealWebSockets(t *testing.T) {
	hostKey := newHostSigner(t)
	var sshdDials atomic.Int32
	handler := norelay.NewHandler(norelay.Config{}, norelay.Dependencies{
		Verifier:      rigVerifier{},
		Upgrader:      norelay.WebSocketUpgrader{},
		FrameUpgrader: norelay.WebSocketUpgrader{},
		Dialer: dialerFunc(func() (norelay.Stream, error) {
			sshdDials.Add(1)
			amikad, sshd := net.Pipe()
			go serveEchoSSH(sshd, hostKey)
			return amikad, nil
		}),
	})
	server := httptest.NewTLSServer(handler)
	defer server.Close()
	defer handler.Close()

	budgets := make(chan int64, 8)
	for _, budget := range []int64{300 << 10, 200 << 10, 400 << 10, 150 << 10} {
		budgets <- budget
	}
	dialer := cuttingDialer{WebSocketDialer: WebSocketDialer{HTTPClient: server.Client()}, budgets: budgets}
	creator := urlCreator{
		connectURL: "wss" + strings.TrimPrefix(server.URL, "https") + "/v1/ssh-sessions",
		hostKey:    strings.TrimSpace(string(cryptossh.MarshalAuthorizedKey(hostKey.PublicKey()))),
	}
	proxyEnd, opensshEnd := net.Pipe()
	result := make(chan error, 1)
	go func() {
		result <- ProxySession(context.Background(), creator, dialer, &fakePinStore{}, "my.team.sbx_123.localhost-3011.amika", proxyEnd, proxyEnd, nil)
	}()

	connection, channels, requests, err := cryptossh.NewClientConn(opensshEnd, "rig", &cryptossh.ClientConfig{
		User:            "amika",
		HostKeyCallback: cryptossh.FixedHostKey(hostKey.PublicKey()),
		Timeout:         10 * time.Second,
	})
	if err != nil {
		t.Fatalf("SSH handshake: %v", err)
	}
	client := cryptossh.NewClient(connection, channels, requests)
	channel, channelRequests, err := client.OpenChannel("echo", nil)
	if err != nil {
		t.Fatalf("open channel: %v", err)
	}
	go cryptossh.DiscardRequests(channelRequests)
	payload := bytes.Repeat([]byte("0123456789abcdef"), 64<<10)
	go func() {
		_, _ = channel.Write(payload)
		_ = channel.CloseWrite()
	}()
	echoed, err := io.ReadAll(channel)
	if err != nil || !bytes.Equal(echoed, payload) {
		t.Fatalf("echoed %d of %d bytes, err %v", len(echoed), len(payload), err)
	}
	_ = client.Close()
	if err := waitResult(t, result); err != nil {
		t.Fatalf("proxy exit = %v", err)
	}
	if len(budgets) != 0 || sshdDials.Load() != 1 {
		t.Fatalf("unused cuts = %d, sshd dials = %d", len(budgets), sshdDials.Load())
	}
}

// P-A2-9 over real WebSockets: an amikad from before resume has only /v1, and
// answers 404 at /v2.
func TestProxySessionUsesV1AgainstAnOldAmikad(t *testing.T) {
	hostKey := newHostSigner(t)
	handler := norelay.NewHandler(norelay.Config{}, norelay.Dependencies{
		Verifier: rigVerifier{},
		Upgrader: norelay.WebSocketUpgrader{},
		Dialer: dialerFunc(func() (norelay.Stream, error) {
			amikad, sshd := net.Pipe()
			go serveEchoSSH(sshd, hostKey)
			return amikad, nil
		}),
	})
	mux := http.NewServeMux()
	mux.Handle(norelay.SSHSessionsPath, handler)
	server := httptest.NewTLSServer(mux)
	defer server.Close()
	defer handler.Close()

	creator := urlCreator{
		connectURL: "wss" + strings.TrimPrefix(server.URL, "https") + "/v1/ssh-sessions",
		hostKey:    strings.TrimSpace(string(cryptossh.MarshalAuthorizedKey(hostKey.PublicKey()))),
	}
	proxyEnd, opensshEnd := net.Pipe()
	events := &lockedBuffer{}
	result := make(chan error, 1)
	go func() {
		result <- ProxySession(context.Background(), creator, WebSocketDialer{HTTPClient: server.Client()}, &fakePinStore{}, "my.team.sbx_123.localhost-3011.amika", proxyEnd, proxyEnd, slog.New(slog.NewJSONHandler(events, nil)))
	}()
	connection, channels, requests, err := cryptossh.NewClientConn(opensshEnd, "rig", &cryptossh.ClientConfig{
		User:            "amika",
		HostKeyCallback: cryptossh.FixedHostKey(hostKey.PublicKey()),
		Timeout:         10 * time.Second,
	})
	if err != nil {
		t.Fatalf("SSH handshake over /v1: %v", err)
	}
	client := cryptossh.NewClient(connection, channels, requests)
	_ = client.Close()
	<-result
	if !strings.Contains(events.String(), `"mode":"raw"`) || !strings.Contains(events.String(), `"status":404`) {
		t.Fatalf("events = %s", events.String())
	}
}

type dialerFunc func() (norelay.Stream, error)

func (f dialerFunc) DialContext(context.Context, string, string) (norelay.Stream, error) { return f() }

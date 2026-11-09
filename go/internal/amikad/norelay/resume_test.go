package norelay

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/gofixpoint/amika/go/internal/sshresume"
	"github.com/gofixpoint/amika/go/internal/sshresume/resumetest"
)

const testToken = "secret-token"

// tokenVerifier is safe for concurrent requests, unlike fakeVerifier.
type tokenVerifier struct{}

func (tokenVerifier) Verify(token string) bool { return token == testToken }

type pipeUpgrader struct {
	ends  chan *resumetest.End
	calls atomic.Int32
}

func (u *pipeUpgrader) UpgradeTransport(http.ResponseWriter, *http.Request) (sshresume.Transport, error) {
	u.calls.Add(1)
	select {
	case end := <-u.ends:
		return end, nil
	default:
		return nil, errors.New("no transport queued")
	}
}

// pipeDialer hands amikad one end of a net.Pipe per dial, and the test the
// other, which plays sshd.
type pipeDialer struct {
	sshd  chan net.Conn
	calls atomic.Int32
}

func (d *pipeDialer) DialContext(context.Context, string, string) (Stream, error) {
	d.calls.Add(1)
	amikad, sshd := net.Pipe()
	d.sshd <- sshd
	return amikad, nil
}

type syncLog struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (l *syncLog) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.buf.Write(p)
}

func (l *syncLog) String() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.buf.String()
}

// events returns each logged line with this message.
func (l *syncLog) events(message string) []map[string]any {
	var events []map[string]any
	for _, line := range strings.Split(strings.TrimSpace(l.String()), "\n") {
		var event map[string]any
		if json.Unmarshal([]byte(line), &event) == nil && event["msg"] == message {
			events = append(events, event)
		}
	}
	return events
}

type resumeHarness struct {
	t        *testing.T
	handler  *Handler
	upgrader *pipeUpgrader
	dialer   *pipeDialer
	clock    *resumetest.FakeClock
	logs     *syncLog
}

func newResumeHarness(t *testing.T, maxConnections int) *resumeHarness {
	t.Helper()
	h := &resumeHarness{
		t:        t,
		upgrader: &pipeUpgrader{ends: make(chan *resumetest.End, 64)},
		dialer:   &pipeDialer{sshd: make(chan net.Conn, 64)},
		clock:    resumetest.NewFakeClock(),
		logs:     &syncLog{},
	}
	h.handler = NewHandler(Config{MaxConnections: maxConnections, SSHDAddress: "127.0.0.1:22"}, Dependencies{
		Verifier:      tokenVerifier{},
		Upgrader:      &fakeUpgrader{stream: newBlockingStream()},
		FrameUpgrader: h.upgrader,
		Dialer:        h.dialer,
		Logger:        slog.New(slog.NewJSONHandler(h.logs, nil)),
		Clock:         h.clock,
	})
	t.Cleanup(h.handler.Close)
	return h
}

// connect serves one /v2 request on a new pipe in the background, and
// returns the client's end. served closes when ServeHTTP returns.
func (h *resumeHarness) connect(fault resumetest.Fault) (resumetest.Peer, <-chan struct{}) {
	client, server := resumetest.Pipe(fault)
	h.upgrader.ends <- server
	served := make(chan struct{})
	go func() {
		defer close(served)
		h.handler.ServeHTTP(httptest.NewRecorder(), authorizedRequest(ResumableSSHSessionsPath))
	}()
	return resumetest.Peer{T: h.t, End: client}, served
}

// open starts a new session, and returns the client's end, the session's
// secret and the sshd end.
func (h *resumeHarness) open() (resumetest.Peer, sshresume.Secret, net.Conn) {
	h.t.Helper()
	peer, _ := h.connect(resumetest.NoFault)
	peer.Send(sshresume.Frame{Type: sshresume.FrameHello, Mode: sshresume.HelloNew})
	welcome := peer.Next(sshresume.FrameWelcome)
	if welcome.Status != sshresume.WelcomeNew || welcome.GraceMillis != 60_000 || welcome.ReplayLimit != sshresume.ReplayLimit {
		h.t.Fatalf("welcome = status %d grace %d limit %d", welcome.Status, welcome.GraceMillis, welcome.ReplayLimit)
	}
	sshd := <-h.dialer.sshd
	h.t.Cleanup(func() { sshd.Close() })
	return peer, welcome.Secret, sshd
}

// resume presents secret on a new transport, and returns its end and
// amikad's WELCOME.
func (h *resumeHarness) resume(secret sshresume.Secret, received uint64) (resumetest.Peer, sshresume.Frame) {
	h.t.Helper()
	peer, _ := h.connect(resumetest.NoFault)
	peer.Send(sshresume.Frame{Type: sshresume.FrameHello, Mode: sshresume.HelloResume, Secret: secret, Count: received})
	return peer, peer.Next(sshresume.FrameWelcome)
}

func authorizedRequest(path string) *http.Request {
	request := httptest.NewRequest(http.MethodGet, path, nil)
	request.Header.Set("Authorization", "Bearer "+testToken)
	return request
}

func readExactly(t *testing.T, conn net.Conn, n int) []byte {
	t.Helper()
	_ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	buffer := make([]byte, n)
	if _, err := io.ReadFull(conn, buffer); err != nil {
		t.Fatalf("read from the sshd end: %v", err)
	}
	return buffer
}

// waitClosed reads the sshd end until amikad closes it.
func waitClosed(t *testing.T, conn net.Conn) {
	t.Helper()
	_ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	for {
		_, err := conn.Read(make([]byte, 64<<10))
		if err == nil {
			continue
		}
		var netErr net.Error
		if errors.As(err, &netErr) && netErr.Timeout() {
			t.Fatal("amikad did not close the sshd connection")
		}
		return
	}
}

func eventually(t *testing.T, condition func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !condition() {
		if time.Now().After(deadline) {
			t.Fatal("timed out waiting for condition")
		}
		time.Sleep(time.Millisecond)
	}
}

func closeCode(err error) websocket.StatusCode {
	var closed resumetest.ClosedError
	if errors.As(err, &closed) {
		return closed.Code
	}
	return -1
}

func TestResumableSessionCarriesBytesToSSHD(t *testing.T) {
	h := newResumeHarness(t, 64)
	client, _, sshd := h.open()
	client.Send(sshresume.Frame{Type: sshresume.FrameData, Payload: []byte("SSH-2.0-client\r\n")})
	if got := readExactly(t, sshd, 16); string(got) != "SSH-2.0-client\r\n" {
		t.Fatalf("sshd read %q", got)
	}
	if _, err := sshd.Write([]byte("SSH-2.0-sshd\r\n")); err != nil {
		t.Fatal(err)
	}
	data := client.Next(sshresume.FrameData)
	if string(data.Payload) != "SSH-2.0-sshd\r\n" || data.Offset != 0 || data.Ack > 16 {
		t.Fatalf("data = offset %d ack %d payload %q", data.Offset, data.Ack, data.Payload)
	}
	open := h.logs.events("ssh_bridge_open")
	if len(open) != 1 || open[0]["mode"] != "resume" || len(open[0]["session_ref"].(string)) != 16 {
		t.Fatalf("open events = %v", open)
	}
}

// P-A2-1, in process: a drop, then a resume within the grace period, loses
// and repeats no byte, and keeps the same sshd connection.
func TestResumableSessionResumesAfterADrop(t *testing.T) {
	h := newResumeHarness(t, 64)
	client, secret, sshd := h.open()
	if _, err := sshd.Write([]byte("before-drop")); err != nil {
		t.Fatal(err)
	}
	client.Next(sshresume.FrameData)
	client.End.Cut()
	eventually(t, func() bool { return len(h.logs.events("ssh_resume_detach")) == 1 })

	h.clock.Advance(sshresume.ResumeGrace - time.Second)
	if _, err := sshd.Write([]byte("while-detached")); err != nil {
		t.Fatal(err)
	}
	// The client wrote nothing to its sink of the first DATA in this test,
	// so it resumes from 0 and gets every byte again, in order.
	resumed, welcome := h.resume(secret, 0)
	if welcome.Status != sshresume.WelcomeResumed || welcome.Count != 0 {
		t.Fatalf("welcome = status %d count %d", welcome.Status, welcome.Count)
	}
	var got []byte
	for len(got) < len("before-dropwhile-detached") {
		data := resumed.Next(sshresume.FrameData)
		if data.Offset != uint64(len(got)) {
			t.Fatalf("data offset %d, want %d", data.Offset, len(got))
		}
		got = append(got, data.Payload...)
	}
	if string(got) != "before-dropwhile-detached" {
		t.Fatalf("resumed bytes = %q", got)
	}
	resumed.Send(sshresume.Frame{Type: sshresume.FrameData, Payload: []byte("after")})
	if got := readExactly(t, sshd, 5); string(got) != "after" {
		t.Fatalf("sshd read %q", got)
	}
	attach := h.logs.events("ssh_resume_attach")
	if len(attach) != 1 || attach[0]["detached_ms"].(float64) != float64((sshresume.ResumeGrace-time.Second).Milliseconds()) {
		t.Fatalf("attach events = %v", attach)
	}
}

// S-A2-1: random secrets never resume a session, and the live session is
// untouched.
func TestResumableSessionRefusesGuessedSecrets(t *testing.T) {
	h := newResumeHarness(t, 64)
	client, _, sshd := h.open()
	for range 50 {
		guess, err := sshresume.NewSecret()
		if err != nil {
			t.Fatal(err)
		}
		attacker, welcome := h.resume(guess, 0)
		if welcome.Status != sshresume.WelcomeUnknown {
			t.Fatalf("a guessed secret got status %d", welcome.Status)
		}
		if code := closeCode(attacker.Closed()); code != websocket.StatusNormalClosure {
			t.Fatalf("close code = %d", code)
		}
	}
	if _, err := sshd.Write([]byte("still-here")); err != nil {
		t.Fatal(err)
	}
	if data := client.Next(sshresume.FrameData); string(data.Payload) != "still-here" {
		t.Fatalf("payload = %q", data.Payload)
	}
	if refused := h.logs.events("ssh_resume_refused"); len(refused) != 50 || refused[0]["reason"] != "unknown" {
		t.Fatalf("refused events = %d", len(refused))
	}
}

// S-A2-2: a real secret names one session on one amikad. Another rig's amikad
// does not know it.
func TestResumableSessionSecretIsUnknownToAnotherRig(t *testing.T) {
	rigA := newResumeHarness(t, 64)
	rigB := newResumeHarness(t, 64)
	_, secretA, _ := rigA.open()
	clientB, _, sshdB := rigB.open()
	if _, welcome := rigB.resume(secretA, 0); welcome.Status != sshresume.WelcomeUnknown {
		t.Fatalf("rig B accepted rig A's secret: status %d", welcome.Status)
	}
	if _, err := sshdB.Write([]byte("b")); err != nil {
		t.Fatal(err)
	}
	clientB.Next(sshresume.FrameData)
}

// S-A2-3 and P-A2-5: no resume within the grace period closes sshd and frees
// the slot. A later resume with the right secret is refused, and no buffered
// byte comes back.
func TestResumableSessionExpiresAfterTheGracePeriod(t *testing.T) {
	h := newResumeHarness(t, 64)
	client, secret, sshd := h.open()
	if _, err := sshd.Write([]byte("buffered")); err != nil {
		t.Fatal(err)
	}
	client.Next(sshresume.FrameData)
	client.End.Cut()
	eventually(t, func() bool { return len(h.logs.events("ssh_resume_detach")) == 1 })
	h.clock.Advance(sshresume.ResumeGrace)
	waitClosed(t, sshd)
	eventually(t, func() bool { return h.handler.ActiveConnections() == 0 })

	late, welcome := h.resume(secret, 0)
	if welcome.Status != sshresume.WelcomeUnknown {
		t.Fatalf("late resume got status %d", welcome.Status)
	}
	if code := closeCode(late.Closed()); code != websocket.StatusNormalClosure {
		t.Fatalf("close code = %d", code)
	}
	closed := h.logs.events("ssh_bridge_close")
	if len(closed) != 1 || closed[0]["reason"] != "grace_expired" || closed[0]["detached_total_ms"].(float64) != 60_000 {
		t.Fatalf("close events = %v", closed)
	}
}

// S-A2-4: the newest resume wins. The replaced transport closes with 4100,
// and later bytes go to the new one only.
func TestResumableSessionNewestResumeTakesOver(t *testing.T) {
	h := newResumeHarness(t, 64)
	first, secret, sshd := h.open()
	second, welcome := h.resume(secret, 0)
	if welcome.Status != sshresume.WelcomeResumed {
		t.Fatalf("welcome status = %d", welcome.Status)
	}
	if code := closeCode(first.Closed()); code != sshresume.CloseTakeover {
		t.Fatalf("replaced transport closed with %d, want %d", code, sshresume.CloseTakeover)
	}
	if _, err := sshd.Write([]byte("only-second")); err != nil {
		t.Fatal(err)
	}
	if data := second.Next(sshresume.FrameData); string(data.Payload) != "only-second" {
		t.Fatalf("payload = %q", data.Payload)
	}
}

// S-A2-4: two resumes at once leave exactly one transport attached.
func TestResumableSessionConcurrentResumesLeaveOneTransport(t *testing.T) {
	h := newResumeHarness(t, 64)
	_, secret, sshd := h.open()
	peers := make([]resumetest.Peer, 2)
	var wg sync.WaitGroup
	for i := range peers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			peers[i], _ = h.resume(secret, 0)
		}()
	}
	wg.Wait()
	if _, err := sshd.Write([]byte("one")); err != nil {
		t.Fatal(err)
	}
	got := make(chan int, 2)
	for i, peer := range peers {
		go func() {
			message, err := peer.End.ReadFrameWithin(time.Second)
			if err == nil {
				if frame, _ := sshresume.ParseFrame(message); frame.Type == sshresume.FrameData {
					got <- i
					return
				}
			}
			got <- -1
		}()
	}
	winners := 0
	for range peers {
		if <-got >= 0 {
			winners++
		}
	}
	if winners != 1 {
		t.Fatalf("%d transports received the bytes, want 1", winners)
	}
}

// The cap counts sessions, attached or detached; a resume takes no new slot,
// and the raw route shares the cap.
func TestResumableSessionsShareTheConnectionCap(t *testing.T) {
	h := newResumeHarness(t, 1)
	client, secret, _ := h.open()
	busy, _ := h.connect(resumetest.NoFault)
	busy.Send(sshresume.Frame{Type: sshresume.FrameHello, Mode: sshresume.HelloNew})
	if welcome := busy.Next(sshresume.FrameWelcome); welcome.Status != sshresume.WelcomeBusy {
		t.Fatalf("status = %d, want busy", welcome.Status)
	}
	if code := closeCode(busy.Closed()); code != websocket.StatusNormalClosure {
		t.Fatalf("close code = %d", code)
	}
	client.End.Cut()
	eventually(t, func() bool { return len(h.logs.events("ssh_resume_detach")) == 1 })

	response := httptest.NewRecorder()
	h.handler.ServeHTTP(response, authorizedRequest(SSHSessionsPath))
	if response.Code != http.StatusTooManyRequests {
		t.Fatalf("raw route status = %d with a detached session holding the slot", response.Code)
	}
	if _, welcome := h.resume(secret, 0); welcome.Status != sshresume.WelcomeResumed {
		t.Fatalf("resume status = %d", welcome.Status)
	}
	if h.dialer.calls.Load() != 1 {
		t.Fatalf("sshd dials = %d, want 1", h.dialer.calls.Load())
	}
}

func TestResumableRouteClosesATransportWithoutHello(t *testing.T) {
	h := newResumeHarness(t, 64)
	silent, served := h.connect(resumetest.NoFault)
	eventually(t, func() bool { return h.clock.Pending() > 0 })
	h.clock.Advance(sshresume.HelloTimeout)
	if code := closeCode(silent.Closed()); code != websocket.StatusPolicyViolation {
		t.Fatalf("close code = %d", code)
	}
	<-served
	if refused := h.logs.events("ssh_resume_refused"); len(refused) != 1 || refused[0]["reason"] != "hello_timeout" {
		t.Fatalf("refused events = %v", refused)
	}
	if h.dialer.calls.Load() != 0 {
		t.Fatal("amikad dialed sshd without a HELLO")
	}
}

func TestResumableRouteCapsTransportsWaitingForHello(t *testing.T) {
	h := newResumeHarness(t, 64)
	for range maxPendingHellos {
		h.connect(resumetest.NoFault)
	}
	eventually(t, func() bool { return h.upgrader.calls.Load() == maxPendingHellos })
	response := httptest.NewRecorder()
	h.handler.ServeHTTP(response, authorizedRequest(ResumableSSHSessionsPath))
	if response.Code != http.StatusTooManyRequests || h.upgrader.calls.Load() != maxPendingHellos {
		t.Fatalf("status = %d, upgrades = %d", response.Code, h.upgrader.calls.Load())
	}
}

// S-A2-6: bad frames end the session that sent them. amikad keeps serving
// every other session.
func TestResumableRouteEndsOnlyTheSessionThatSentBadFrames(t *testing.T) {
	h := newResumeHarness(t, 64)
	for _, first := range [][]byte{{42}, {byte(sshresume.FrameData), 0}, {}} {
		bad, served := h.connect(resumetest.NoFault)
		if err := bad.End.WriteFrame(first); err != nil {
			t.Fatal(err)
		}
		if code := closeCode(bad.Closed()); code != websocket.StatusPolicyViolation {
			t.Fatalf("close code = %d", code)
		}
		<-served
	}
	if h.dialer.calls.Load() != 0 {
		t.Fatal("a bad HELLO reached sshd")
	}

	healthy, _, healthySSHD := h.open()
	bad, _, badSSHD := h.open()
	if err := bad.End.WriteFrame([]byte{byte(sshresume.FrameAck), 1}); err != nil {
		t.Fatal(err)
	}
	if abort := bad.Next(sshresume.FrameAbort); abort.Reason != sshresume.AbortProtocol {
		t.Fatalf("abort reason = %d", abort.Reason)
	}
	waitClosed(t, badSSHD)
	if _, err := healthySSHD.Write([]byte("fine")); err != nil {
		t.Fatal(err)
	}
	healthy.Next(sshresume.FrameData)
}

// S-A2-7: a client that never acknowledges gets at most ReplayLimit bytes,
// and the session ends after the grace period with the buffer full.
func TestResumableSessionEndsWhenTheClientNeverAcknowledges(t *testing.T) {
	h := newResumeHarness(t, 64)
	client, _, sshd := h.open()
	go func() {
		chunk := make([]byte, 32<<10)
		for {
			if _, err := sshd.Write(chunk); err != nil {
				return
			}
		}
	}()
	var received int
	for received < sshresume.ReplayLimit {
		received += len(client.Next(sshresume.FrameData).Payload)
	}
	if message, err := client.End.ReadFrameWithin(50 * time.Millisecond); err == nil {
		if frame, _ := sshresume.ParseFrame(message); frame.Type == sshresume.FrameData {
			t.Fatal("amikad sent more than ReplayLimit unacknowledged bytes")
		}
	}
	// The client stays alive, pinging as a real one does, but never acks.
	for range sshresume.ResumeGrace / sshresume.PingInterval {
		client.Send(sshresume.Frame{Type: sshresume.FramePing, Nonce: 1})
		client.Next(sshresume.FramePong)
		h.clock.Advance(sshresume.PingInterval)
	}
	if abort := client.Next(sshresume.FrameAbort); abort.Reason != sshresume.AbortStalled {
		t.Fatalf("abort reason = %d", abort.Reason)
	}
	eventually(t, func() bool { return h.handler.ActiveConnections() == 0 })
}

// S-A2-8.
func TestResumableRouteRequiresTheConnectToken(t *testing.T) {
	h := newResumeHarness(t, 64)
	for _, header := range []string{"", "Bearer wrong-token", "Basic " + testToken} {
		request := httptest.NewRequest(http.MethodGet, ResumableSSHSessionsPath, nil)
		if header != "" {
			request.Header.Set("Authorization", header)
		}
		response := httptest.NewRecorder()
		h.handler.ServeHTTP(response, request)
		if response.Code != http.StatusUnauthorized {
			t.Fatalf("header %q: status = %d", header, response.Code)
		}
	}
	if h.upgrader.calls.Load() != 0 {
		t.Fatal("an unauthenticated request was upgraded")
	}
}

func TestResumableSessionEndsOnTheClientsGoodbye(t *testing.T) {
	h := newResumeHarness(t, 64)
	client, _, sshd := h.open()
	client.Send(sshresume.Frame{Type: sshresume.FrameData, Payload: []byte("last")})
	readExactly(t, sshd, 4)
	client.Send(sshresume.Frame{Type: sshresume.FrameGoodbye, Count: 4})
	if ack := client.Next(sshresume.FrameAck); ack.Ack != 4 {
		t.Fatalf("ack = %d", ack.Ack)
	}
	waitClosed(t, sshd)
	eventually(t, func() bool { return len(h.logs.events("ssh_bridge_close")) == 1 })
	if closed := h.logs.events("ssh_bridge_close")[0]; closed["reason"] != "client_closed" || closed["end"] != "goodbye_received" {
		t.Fatalf("close event = %v", closed)
	}
	if h.handler.ActiveConnections() != 0 {
		t.Fatal("slot not released")
	}
}

// P-A2-6: sshd ends; amikad sends GOODBYE after its last byte, and ends at the
// client's ACK.
func TestResumableSessionSendsGoodbyeWhenSSHDCloses(t *testing.T) {
	h := newResumeHarness(t, 64)
	client, _, sshd := h.open()
	if _, err := sshd.Write([]byte("bye")); err != nil {
		t.Fatal(err)
	}
	sshd.Close()
	client.Next(sshresume.FrameData)
	if goodbye := client.Next(sshresume.FrameGoodbye); goodbye.Count != 3 {
		t.Fatalf("goodbye count = %d", goodbye.Count)
	}
	client.Send(sshresume.Frame{Type: sshresume.FrameAck, Ack: 3})
	eventually(t, func() bool { return len(h.logs.events("ssh_bridge_close")) == 1 })
	if closed := h.logs.events("ssh_bridge_close")[0]; closed["reason"] != "sshd_closed" {
		t.Fatalf("close event = %v", closed)
	}
}

func TestResumableSessionRefusesAResumeCountItNeverSent(t *testing.T) {
	h := newResumeHarness(t, 64)
	client, secret, sshd := h.open()
	client.End.Cut()
	eventually(t, func() bool { return len(h.logs.events("ssh_resume_detach")) == 1 })
	resumed, _ := h.connect(resumetest.NoFault)
	resumed.Send(sshresume.Frame{Type: sshresume.FrameHello, Mode: sshresume.HelloResume, Secret: secret, Count: 10})
	if abort := resumed.Next(sshresume.FrameAbort); abort.Reason != sshresume.AbortProtocol {
		t.Fatalf("abort reason = %d", abort.Reason)
	}
	waitClosed(t, sshd)
}

// Shutdown sends ABORT on every attached transport, and closes every sshd
// connection, attached or not.
func TestResumableSessionsAbortOnShutdown(t *testing.T) {
	h := newResumeHarness(t, 64)
	attached, _, attachedSSHD := h.open()
	detached, _, detachedSSHD := h.open()
	detached.End.Cut()
	eventually(t, func() bool { return len(h.logs.events("ssh_resume_detach")) == 1 })
	h.handler.Close()
	if abort := attached.Next(sshresume.FrameAbort); abort.Reason != sshresume.AbortShutdown {
		t.Fatalf("abort reason = %d", abort.Reason)
	}
	waitClosed(t, attachedSSHD)
	waitClosed(t, detachedSSHD)
	if h.handler.ActiveConnections() != 0 {
		t.Fatal("slots not released")
	}
}

// Nothing amikad logs may hold the secret, the connect token or session bytes.
func TestResumableSessionLogsNoSecrets(t *testing.T) {
	h := newResumeHarness(t, 64)
	client, secret, sshd := h.open()
	client.Send(sshresume.Frame{Type: sshresume.FrameData, Payload: []byte("session-bytes-from-client")})
	readExactly(t, sshd, len("session-bytes-from-client"))
	client.End.Cut()
	eventually(t, func() bool { return len(h.logs.events("ssh_resume_detach")) == 1 })
	resumed, _ := h.resume(secret, 0)
	resumed.Send(sshresume.Frame{Type: sshresume.FrameGoodbye, Count: uint64(len("session-bytes-from-client"))})
	resumed.Next(sshresume.FrameAck)
	eventually(t, func() bool { return len(h.logs.events("ssh_bridge_close")) == 1 })

	logs := h.logs.String()
	for _, forbidden := range []string{
		hex.EncodeToString(secret[:]),
		base64.StdEncoding.EncodeToString(secret[:]),
		base64.RawURLEncoding.EncodeToString(secret[:]),
		testToken,
		"session-bytes-from-client",
	} {
		if strings.Contains(logs, forbidden) {
			t.Fatalf("logs hold %q:\n%s", forbidden, logs)
		}
	}
	ref := secret.Hash().Ref()
	for _, message := range []string{"ssh_bridge_open", "ssh_resume_detach", "ssh_resume_attach", "ssh_bridge_close"} {
		events := h.logs.events(message)
		if len(events) != 1 || events[0]["session_ref"] != ref {
			t.Fatalf("%s events = %v, want one with session_ref %s", message, events, ref)
		}
	}
}

// A takeover waits for the old transport's reader, which may be stuck writing
// to an sshd that reads nothing. Shutdown must still finish: it closes sshd,
// which ends that write.
func TestResumableShutdownDoesNotWaitForAStuckTakeover(t *testing.T) {
	h := newResumeHarness(t, 64)
	client, secret, _ := h.open()
	// sshd never reads, so amikad's write of this DATA blocks.
	client.Send(sshresume.Frame{Type: sshresume.FrameData, Payload: []byte("stuck")})
	time.Sleep(20 * time.Millisecond)
	takeover, _ := h.connect(resumetest.NoFault)
	takeover.Send(sshresume.Frame{Type: sshresume.FrameHello, Mode: sshresume.HelloResume, Secret: secret})
	time.Sleep(20 * time.Millisecond)

	closed := make(chan struct{})
	go func() {
		h.handler.Close()
		close(closed)
	}()
	select {
	case <-closed:
	case <-time.After(5 * time.Second):
		t.Fatal("shutdown waited on a takeover stuck behind an sshd write")
	}
	eventually(t, func() bool { return h.handler.ActiveConnections() == 0 })
}

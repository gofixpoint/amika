package sshresume_test

import (
	"bytes"
	"errors"
	"io"
	"math/rand/v2"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/gofixpoint/amika/go/internal/sshresume"
	"github.com/gofixpoint/amika/go/internal/sshresume/resumetest"
)

// gatedSource returns its data, then blocks until Release, then returns EOF.
// A session's GOODBYE ends both directions, so the property tests hold each
// source open until the peer has every byte.
type gatedSource struct {
	data     []byte
	released chan struct{}
	once     sync.Once
}

func newGatedSource(data []byte) *gatedSource {
	return &gatedSource{data: data, released: make(chan struct{})}
}

func (g *gatedSource) Read(p []byte) (int, error) {
	if len(g.data) > 0 {
		n := copy(p, g.data)
		g.data = g.data[n:]
		return n, nil
	}
	<-g.released
	return 0, io.EOF
}

func (g *gatedSource) Release() { g.once.Do(func() { close(g.released) }) }

type syncBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *syncBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *syncBuffer) Len() int {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Len()
}

func (b *syncBuffer) Bytes() []byte {
	b.mu.Lock()
	defer b.mu.Unlock()
	return append([]byte(nil), b.buf.Bytes()...)
}

func fastTiming() sshresume.Timing {
	return sshresume.Timing{
		AckDelay:     time.Millisecond,
		PingInterval: 20 * time.Millisecond,
		DeadAfter:    150 * time.Millisecond,
		ResumeGrace:  30 * time.Second,
	}
}

// attachPair carries both streams on a new pipe, each from the other's
// received count, as the handshake would.
func attachPair(t *testing.T, client, server *sshresume.Stream, fault resumetest.Fault) (clientAttach, serverAttach *sshresume.Attachment, err error) {
	t.Helper()
	clientEnd, serverEnd := resumetest.Pipe(fault)
	serverAttach, err = server.Attach(serverEnd, client.Received(), false)
	if err != nil {
		clientEnd.Close(websocket.StatusNormalClosure)
		return nil, nil, err
	}
	clientAttach, err = client.Attach(clientEnd, server.Received(), false)
	if err != nil {
		serverAttach.Replace()
		return nil, nil, err
	}
	return clientAttach, serverAttach, nil
}

func waitDone(t *testing.T, done <-chan struct{}, what string) {
	t.Helper()
	select {
	case <-done:
	case <-time.After(10 * time.Second):
		t.Fatalf("timed out waiting for %s", what)
	}
}

func endOf(t *testing.T, s *sshresume.Stream) sshresume.End {
	t.Helper()
	waitDone(t, s.Done(), "session end")
	end, _ := s.End()
	return end
}

func TestStreamCarriesBytesBothWaysAndEndsOnGoodbye(t *testing.T) {
	clientData := bytes.Repeat([]byte("from-openssh "), 50_000)
	serverData := bytes.Repeat([]byte("from-sshd "), 70_000)
	clientSource, serverSource := newGatedSource(clientData), newGatedSource(serverData)
	clientSink, serverSink := &syncBuffer{}, &syncBuffer{}
	options := sshresume.Options{Timing: fastTiming()}
	client := sshresume.NewStream(sshresume.RoleClient, clientSource, clientSink, options)
	server := sshresume.NewStream(sshresume.RoleServer, serverSource, serverSink, options)
	if _, _, err := attachPair(t, client, server, resumetest.NoFault); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool { return clientSink.Len() == len(serverData) && serverSink.Len() == len(clientData) })
	clientSource.Release()

	if end := endOf(t, client); end.Kind != sshresume.EndGoodbyeAcked {
		t.Fatalf("client end = %s", end.Name())
	}
	if end := endOf(t, server); end.Kind != sshresume.EndGoodbyeReceived {
		t.Fatalf("server end = %s", end.Name())
	}
	if !bytes.Equal(clientSink.Bytes(), serverData) || !bytes.Equal(serverSink.Bytes(), clientData) {
		t.Fatal("a sink differs from its peer's source")
	}
}

// The property the design rests on: cut the transport at random points, or
// black-hole it, again and again; every byte still arrives exactly once and in
// order, in both directions.
func TestStreamSurvivesRandomCuts(t *testing.T) {
	sessions := 40
	if testing.Short() {
		sessions = 8
	}
	resumes := 0
	for seed := range uint64(sessions) {
		resumes += runCutSession(t, seed)
	}
	// Guard against a fault model that stops faulting: the sessions must
	// have resumed many times.
	if resumes < sessions {
		t.Fatalf("%d sessions resumed only %d times", sessions, resumes)
	}
	t.Logf("%d sessions, %d resumes", sessions, resumes)
}

// runCutSession runs one session over faulty transports until it ends, and
// returns how many times it resumed.
func runCutSession(t *testing.T, seed uint64) int {
	rng := rand.New(rand.NewPCG(seed, 0x5eed))
	clientData := randomBytes(rng, rng.IntN(3<<20))
	serverData := randomBytes(rng, rng.IntN(3<<20))
	clientSource, serverSource := newGatedSource(clientData), newGatedSource(serverData)
	clientSink, serverSink := &syncBuffer{}, &syncBuffer{}
	options := sshresume.Options{Timing: fastTiming()}
	client := sshresume.NewStream(sshresume.RoleClient, clientSource, clientSink, options)
	server := sshresume.NewStream(sshresume.RoleServer, serverSource, serverSink, options)
	delivered := func() bool {
		return clientSink.Len() == len(serverData) && serverSink.Len() == len(clientData)
	}

	transports := 0
	for ; ; transports++ {
		if transports > 400 {
			t.Fatalf("seed %d: no progress after %d transports", seed, transports)
		}
		clientAttach, serverAttach, err := attachPair(t, client, server, randomFault(rng))
		if errors.Is(err, sshresume.ErrEnded) {
			break
		}
		if err != nil {
			t.Fatalf("seed %d: attach: %v", seed, err)
		}
		for !isDone(clientAttach.Done()) || !isDone(serverAttach.Done()) {
			if delivered() {
				clientSource.Release()
			}
			time.Sleep(time.Millisecond)
		}
		if isDone(client.Done()) || isDone(server.Done()) {
			break
		}
	}

	// A GOODBYE whose ACK was cut leaves one side ended and the other
	// detached. The client then learns the session is unknown and, having
	// sent GOODBYE itself, exits 0; amikad expires the session at grace.
	if !isDone(server.Done()) {
		server.Expire()
	}
	if !isDone(client.Done()) {
		client.Expire()
	}
	if !bytes.Equal(serverSink.Bytes(), clientData) {
		t.Fatalf("seed %d: server sink (%d bytes) differs from client source (%d bytes)", seed, serverSink.Len(), len(clientData))
	}
	if !bytes.Equal(clientSink.Bytes(), serverData) {
		t.Fatalf("seed %d: client sink (%d bytes) differs from server source (%d bytes)", seed, clientSink.Len(), len(serverData))
	}
	for _, s := range []*sshresume.Stream{client, server} {
		end, _ := s.End()
		switch end.Kind {
		case sshresume.EndGoodbyeAcked, sshresume.EndGoodbyeReceived, sshresume.EndExpired:
		default:
			t.Fatalf("seed %d: session ended with %s", seed, end.Name())
		}
	}
	return transports
}

// randomFault cuts within the first frames (the acks, a resend's start), or
// anywhere in the first MiB, or black-holes the pipe; one transport in five
// is left alone, so a session finishes.
func randomFault(rng *rand.Rand) resumetest.Fault {
	fault := resumetest.NoFault
	switch rng.IntN(20) {
	case 0, 1, 2, 3:
		fault.CutAt = rng.Int64N(256)
	case 4, 5, 6, 7, 8, 9, 10, 11, 12:
		fault.CutAt = rng.Int64N(1 << 20)
	case 13, 14, 15:
		fault.SilentAt = rng.Int64N(1 << 20)
	}
	return fault
}

func randomBytes(rng *rand.Rand, n int) []byte {
	data := make([]byte, n)
	for i := range data {
		data[i] = byte(rng.Uint32())
	}
	return data
}

func isDone(ch <-chan struct{}) bool {
	select {
	case <-ch:
		return true
	default:
		return false
	}
}

func waitFor(t *testing.T, condition func() bool) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for !condition() {
		if time.Now().After(deadline) {
			t.Fatal("timed out waiting for condition")
		}
		time.Sleep(time.Millisecond)
	}
}

// countingSource never ends, and counts what it hands out.
type countingSource struct {
	mu   sync.Mutex
	read int
}

func (c *countingSource) Read(p []byte) (int, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.read += len(p)
	return len(p), nil
}

func (c *countingSource) total() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.read
}

// With no transport, a side reads its source only up to ReplayLimit, then
// stops: backpressure, and no byte dropped.
func TestStreamStopsReadingItsSourceAtTheReplayLimit(t *testing.T) {
	source := &countingSource{}
	stream := sshresume.NewStream(sshresume.RoleServer, source, io.Discard, sshresume.Options{})
	defer stream.Expire()
	waitFor(t, func() bool { return stream.Counters().Sent == sshresume.ReplayLimit })
	time.Sleep(20 * time.Millisecond)
	if read := source.total(); read != sshresume.ReplayLimit {
		t.Fatalf("source read %d bytes, want %d", read, sshresume.ReplayLimit)
	}
}

func attachedServer(t *testing.T, source io.Reader, sink io.Writer, clock sshresume.Clock) (*sshresume.Stream, *sshresume.Attachment, resumetest.Peer) {
	t.Helper()
	stream := sshresume.NewStream(sshresume.RoleServer, source, sink, sshresume.Options{Clock: clock})
	clientEnd, serverEnd := resumetest.Pipe(resumetest.NoFault)
	attachment, err := stream.Attach(serverEnd, 0, false)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		stream.Expire()
		clientEnd.Close(websocket.StatusNormalClosure)
	})
	return stream, attachment, resumetest.Peer{T: t, End: clientEnd}
}

func blockingSource() io.Reader {
	reader, _ := io.Pipe()
	return reader
}

// A peer that breaks the protocol gets ABORT, and the session ends.
func TestStreamAbortsOnProtocolViolations(t *testing.T) {
	for name, frames := range map[string][]sshresume.Frame{
		"ack of bytes never sent": {{Type: sshresume.FrameAck, Ack: 1}},
		"DATA at the wrong offset": {
			{Type: sshresume.FrameData, Offset: 5, Payload: []byte("x")},
		},
		"DATA that acks too much": {
			{Type: sshresume.FrameData, Offset: 0, Ack: 10, Payload: []byte("x")},
		},
		"PONG sent to the server":    {{Type: sshresume.FramePong}},
		"HELLO after the handshake":  {{Type: sshresume.FrameHello, Mode: sshresume.HelloNew}},
		"GOODBYE before its bytes":   {{Type: sshresume.FrameGoodbye, Count: 3}},
		"WELCOME from the client":    {{Type: sshresume.FrameWelcome, Status: sshresume.WelcomeBusy}},
		"repeated DATA after resend": {{Type: sshresume.FrameData, Payload: []byte("ab")}, {Type: sshresume.FrameData, Payload: []byte("ab")}},
	} {
		t.Run(name, func(t *testing.T) {
			sink := &syncBuffer{}
			stream, _, client := attachedServer(t, blockingSource(), sink, resumetest.NewFakeClock())
			for _, frame := range frames {
				client.Send(frame)
			}
			if abort := client.Next(sshresume.FrameAbort); abort.Reason != sshresume.AbortProtocol {
				t.Fatalf("abort reason = %d", abort.Reason)
			}
			if end := endOf(t, stream); end.Kind != sshresume.EndAborted || end.Reason != sshresume.AbortProtocol {
				t.Fatalf("end = %s", end.Name())
			}
		})
	}
}

func TestStreamAbortsOnAnUnknownFrameType(t *testing.T) {
	stream, _, client := attachedServer(t, blockingSource(), io.Discard, resumetest.NewFakeClock())
	if err := client.End.WriteFrame([]byte{42, 0}); err != nil {
		t.Fatal(err)
	}
	client.Next(sshresume.FrameAbort)
	if end := endOf(t, stream); end.Reason != sshresume.AbortProtocol {
		t.Fatalf("end = %s", end.Name())
	}
}

// An ack that goes backwards is as wrong as one that runs ahead.
func TestStreamAbortsOnADecreasingAck(t *testing.T) {
	stream, _, client := attachedServer(t, newGatedSource([]byte("hello")), io.Discard, resumetest.NewFakeClock())
	client.Next(sshresume.FrameData)
	client.Send(sshresume.Frame{Type: sshresume.FrameAck, Ack: 5})
	waitFor(t, func() bool { return stream.Counters().Acked == 5 })
	client.Send(sshresume.Frame{Type: sshresume.FrameAck, Ack: 4})
	client.Next(sshresume.FrameAbort)
	if end := endOf(t, stream); end.Reason != sshresume.AbortProtocol {
		t.Fatalf("end = %s", end.Name())
	}
}

func TestStreamAnswersPingWithPongCarryingItsAck(t *testing.T) {
	sink := &syncBuffer{}
	_, _, client := attachedServer(t, blockingSource(), sink, resumetest.NewFakeClock())
	client.Send(sshresume.Frame{Type: sshresume.FrameData, Payload: []byte("abc")})
	waitFor(t, func() bool { return sink.Len() == 3 })
	client.Send(sshresume.Frame{Type: sshresume.FramePing, Nonce: 77})
	pong := client.Next(sshresume.FramePong)
	if pong.Nonce != 77 || pong.Ack != 3 {
		t.Fatalf("pong = nonce %d ack %d", pong.Nonce, pong.Ack)
	}
}

func TestStreamAcksAfterTheDelayWhenIdle(t *testing.T) {
	clock := resumetest.NewFakeClock()
	sink := &syncBuffer{}
	_, _, client := attachedServer(t, blockingSource(), sink, clock)
	client.Send(sshresume.Frame{Type: sshresume.FrameData, Payload: []byte("abc")})
	waitFor(t, func() bool { return sink.Len() == 3 })
	clock.Advance(sshresume.AckDelay)
	if ack := client.Next(sshresume.FrameAck); ack.Ack != 3 {
		t.Fatalf("ack = %d", ack.Ack)
	}
}

func TestStreamAcksAtOnceAfterAckBytes(t *testing.T) {
	sink := &syncBuffer{}
	_, _, client := attachedServer(t, blockingSource(), sink, resumetest.NewFakeClock())
	payload := make([]byte, sshresume.MaxDataBytes)
	for offset := uint64(0); offset < sshresume.AckBytes; offset += uint64(len(payload)) {
		client.Send(sshresume.Frame{Type: sshresume.FrameData, Offset: offset, Payload: payload})
	}
	if ack := client.Next(sshresume.FrameAck); ack.Ack != sshresume.AckBytes {
		t.Fatalf("ack = %d", ack.Ack)
	}
}

func TestStreamClientPingsAfterTheIntervalIdle(t *testing.T) {
	clock := resumetest.NewFakeClock()
	stream := sshresume.NewStream(sshresume.RoleClient, blockingSource(), io.Discard, sshresume.Options{Clock: clock})
	defer stream.Expire()
	clientEnd, serverEnd := resumetest.Pipe(resumetest.NoFault)
	if _, err := stream.Attach(clientEnd, 0, false); err != nil {
		t.Fatal(err)
	}
	frames := make(chan sshresume.Frame, 8)
	go func() {
		for {
			message, err := serverEnd.ReadFrame()
			if err != nil {
				return
			}
			frame, _ := sshresume.ParseFrame(message)
			frames <- frame
		}
	}()
	clock.Advance(sshresume.PingInterval - time.Millisecond)
	select {
	case <-time.After(20 * time.Millisecond):
	case frame := <-frames:
		t.Fatalf("client sent type %d before the ping interval", frame.Type)
	}
	clock.Advance(time.Millisecond)
	select {
	case frame := <-frames:
		if frame.Type != sshresume.FramePing {
			t.Fatalf("frame type = %d, want PING", frame.Type)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("no PING after the interval")
	}
}

// No frame for DeadAfter ends the transport but keeps the session.
func TestStreamDropsASilentTransportAfterDeadAfter(t *testing.T) {
	clock := resumetest.NewFakeClock()
	stream, attachment, _ := attachedServer(t, blockingSource(), io.Discard, clock)
	clock.Advance(sshresume.DeadAfter - time.Millisecond)
	if isDone(attachment.Done()) {
		t.Fatal("transport dropped before DeadAfter")
	}
	clock.Advance(time.Millisecond)
	waitDone(t, attachment.Done(), "drop")
	if attachment.Cause() != sshresume.DetachDropped || isDone(stream.Done()) {
		t.Fatal("a silent transport must drop without ending the session")
	}
}

// blockedSink blocks every write until released.
type blockedSink struct{ release chan struct{} }

func (b blockedSink) Write(p []byte) (int, error) {
	<-b.release
	return len(p), nil
}

// A receiver blocked on its sink is not reading, so silence then does not
// mean the transport is dead.
func TestStreamDeadTimerWaitsForAWriteToTheSink(t *testing.T) {
	clock := resumetest.NewFakeClock()
	sink := blockedSink{release: make(chan struct{})}
	_, attachment, client := attachedServer(t, blockingSource(), sink, clock)
	client.Send(sshresume.Frame{Type: sshresume.FrameData, Payload: []byte("x")})
	time.Sleep(20 * time.Millisecond)
	clock.Advance(3 * sshresume.DeadAfter)
	if isDone(attachment.Done()) {
		t.Fatal("transport dropped while its reader wrote to the sink")
	}
	close(sink.release)
}

// A peer that never acknowledges cannot hold more than ReplayLimit, and the
// session ends after ResumeGrace with a full buffer.
func TestStreamAbortsAPeerThatNeverAcknowledges(t *testing.T) {
	clock := resumetest.NewFakeClock()
	stream, _, client := attachedServer(t, &countingSource{}, io.Discard, clock)
	var received uint64
	for received < sshresume.ReplayLimit {
		received += uint64(len(client.Next(sshresume.FrameData).Payload))
	}
	if received != sshresume.ReplayLimit || stream.Counters().Sent != sshresume.ReplayLimit {
		t.Fatalf("sent %d bytes without acks, want %d", received, sshresume.ReplayLimit)
	}
	for range 3 {
		client.Send(sshresume.Frame{Type: sshresume.FramePing})
		client.Next(sshresume.FramePong)
		clock.Advance(sshresume.ResumeGrace / 3)
	}
	if abort := client.Next(sshresume.FrameAbort); abort.Reason != sshresume.AbortStalled {
		t.Fatalf("abort reason = %d", abort.Reason)
	}
	if end := endOf(t, stream); end.Reason != sshresume.AbortStalled {
		t.Fatalf("end = %s", end.Name())
	}
}

type failingSink struct{}

func (failingSink) Write([]byte) (int, error) { return 0, errors.New("sink gone") }

func TestStreamAbortsWhenItsSinkFails(t *testing.T) {
	stream, _, client := attachedServer(t, blockingSource(), failingSink{}, resumetest.NewFakeClock())
	client.Send(sshresume.Frame{Type: sshresume.FrameData, Payload: []byte("x")})
	if abort := client.Next(sshresume.FrameAbort); abort.Reason != sshresume.AbortSinkFailed {
		t.Fatalf("abort reason = %d", abort.Reason)
	}
	if end := endOf(t, stream); end.Reason != sshresume.AbortSinkFailed {
		t.Fatalf("end = %s", end.Name())
	}
}

func TestStreamEndsOnAReceivedAbort(t *testing.T) {
	stream, _, client := attachedServer(t, blockingSource(), io.Discard, resumetest.NewFakeClock())
	client.Send(sshresume.Frame{Type: sshresume.FrameAbort, Reason: 99})
	if end := endOf(t, stream); end.Kind != sshresume.EndAbortReceived || end.Reason != 99 {
		t.Fatalf("end = %s", end.Name())
	}
}

// A resume that claims more bytes than this side ever sent, or fewer than the
// peer already acknowledged, is refused with ABORT.
func TestStreamRefusesAResumeCountOutOfRange(t *testing.T) {
	stream := sshresume.NewStream(sshresume.RoleServer, blockingSource(), io.Discard, sshresume.Options{})
	clientEnd, serverEnd := resumetest.Pipe(resumetest.NoFault)
	if _, err := stream.Attach(serverEnd, 1, true); !errors.Is(err, sshresume.ErrProtocol) {
		t.Fatalf("attach error = %v", err)
	}
	if abort := (resumetest.Peer{T: t, End: clientEnd}).Next(sshresume.FrameAbort); abort.Reason != sshresume.AbortProtocol {
		t.Fatalf("abort reason = %d", abort.Reason)
	}
	if end := endOf(t, stream); end.Reason != sshresume.AbortProtocol {
		t.Fatalf("end = %s", end.Name())
	}
}

func TestStreamResumeSendsWelcomeThenResends(t *testing.T) {
	stream := sshresume.NewStream(sshresume.RoleServer, newGatedSource([]byte("abcdef")), io.Discard, sshresume.Options{})
	defer stream.Expire()
	firstClient, firstServer := resumetest.Pipe(resumetest.NoFault)
	first, err := stream.Attach(firstServer, 0, false)
	if err != nil {
		t.Fatal(err)
	}
	if data := (resumetest.Peer{T: t, End: firstClient}).Next(sshresume.FrameData); string(data.Payload) != "abcdef" {
		t.Fatalf("payload = %q", data.Payload)
	}
	first.Replace()
	if code, _ := firstClient.PeerCloseCode(); code != sshresume.CloseTakeover {
		t.Fatalf("close code = %d, want %d", code, sshresume.CloseTakeover)
	}

	secondClient, secondServer := resumetest.Pipe(resumetest.NoFault)
	second, err := stream.Attach(secondServer, 2, true)
	if err != nil {
		t.Fatal(err)
	}
	client := resumetest.Peer{T: t, End: secondClient}
	welcome := client.Next(sshresume.FrameWelcome)
	if welcome.Status != sshresume.WelcomeResumed || welcome.Count != 0 {
		t.Fatalf("welcome = status %d count %d", welcome.Status, welcome.Count)
	}
	if data := client.Next(sshresume.FrameData); data.Offset != 2 || string(data.Payload) != "cdef" {
		t.Fatalf("resent offset %d payload %q", data.Offset, data.Payload)
	}
	if second.Resent() != 4 {
		t.Fatalf("resent = %d", second.Resent())
	}
}

// FuzzStreamFrames sends arbitrary frame sequences to amikad's side of a
// session. It must never panic. A model of the rules predicts which DATA
// reach the sink and how the session ends; the stream must agree.
//
// Each input ends with a sentinel ABORT rather than a close: a closed peer
// makes this side's next write fail, which drops the transport and rightly
// leaves later frames unread, so the outcome would depend on timing.
func FuzzStreamFrames(f *testing.F) {
	encode := func(frames ...sshresume.Frame) []byte {
		var input []byte
		for _, frame := range frames {
			encoded, _ := sshresume.MarshalFrame(frame)
			input = append(input, byte(len(encoded)>>8), byte(len(encoded)))
			input = append(input, encoded...)
		}
		return input
	}
	f.Add(encode(sshresume.Frame{Type: sshresume.FrameData, Payload: []byte("abc")}, sshresume.Frame{Type: sshresume.FrameGoodbye, Count: 3}))
	f.Add(encode(sshresume.Frame{Type: sshresume.FramePing, Nonce: 1}, sshresume.Frame{Type: sshresume.FrameAck}))
	f.Add(encode(sshresume.Frame{Type: sshresume.FrameData, Offset: 1, Payload: []byte("x")}))
	f.Add([]byte{0, 2, 9, 9})
	sentinel, _ := sshresume.MarshalFrame(sshresume.Frame{Type: sshresume.FrameAbort, Reason: fuzzSentinelReason})
	f.Fuzz(func(t *testing.T, input []byte) {
		frames := append(splitFrames(input), sentinel)
		want := modelServer(frames)

		sink := &syncBuffer{}
		source, sourceWriter := io.Pipe()
		defer sourceWriter.Close()
		stream := sshresume.NewStream(sshresume.RoleServer, source, sink, sshresume.Options{Clock: resumetest.NewFakeClock()})
		clientEnd, serverEnd := resumetest.Pipe(resumetest.NoFault)
		defer clientEnd.Close(websocket.StatusNormalClosure)
		attachment, err := stream.Attach(serverEnd, 0, false)
		if err != nil {
			t.Fatal(err)
		}
		go func() {
			for {
				if _, err := clientEnd.ReadFrame(); err != nil {
					return
				}
			}
		}()
		for _, frame := range frames {
			if err := clientEnd.WriteFrame(frame); err != nil {
				break
			}
		}
		waitDone(t, attachment.Done(), "attachment")

		if !bytes.Equal(sink.Bytes(), want.sink) {
			t.Fatalf("sink has %d bytes, the model %d", sink.Len(), len(want.sink))
		}
		end, ended := stream.End()
		if !ended || end != want.end {
			t.Fatalf("end = %v %s, the model %s", ended, end.Name(), want.end.Name())
		}
	})
}

// fuzzSentinelReason marks the ABORT FuzzStreamFrames appends to each input.
const fuzzSentinelReason sshresume.AbortReason = 0xee

func splitFrames(input []byte) [][]byte {
	var frames [][]byte
	for len(input) >= 2 {
		size := int(input[0])<<8 | int(input[1])
		input = input[2:]
		if size > len(input) {
			size = len(input)
		}
		frames = append(frames, input[:size])
		input = input[size:]
	}
	return frames
}

type modelResult struct {
	sink  []byte
	ended bool
	end   sshresume.End
}

// modelServer applies the design's rules to a server whose source has sent
// nothing, so the only valid ack is 0.
func modelServer(frames [][]byte) modelResult {
	var result modelResult
	abort := func(reason sshresume.AbortReason) modelResult {
		result.ended, result.end = true, sshresume.End{Kind: sshresume.EndAborted, Reason: reason}
		return result
	}
	for _, message := range frames {
		frame, err := sshresume.ParseFrame(message)
		if err != nil {
			return abort(sshresume.AbortProtocol)
		}
		switch frame.Type {
		case sshresume.FrameData:
			if frame.Offset != uint64(len(result.sink)) || frame.Ack != 0 {
				return abort(sshresume.AbortProtocol)
			}
			result.sink = append(result.sink, frame.Payload...)
		case sshresume.FrameAck:
			if frame.Ack != 0 {
				return abort(sshresume.AbortProtocol)
			}
		case sshresume.FramePing:
		case sshresume.FrameGoodbye:
			if frame.Count != uint64(len(result.sink)) {
				return abort(sshresume.AbortProtocol)
			}
			result.ended, result.end = true, sshresume.End{Kind: sshresume.EndGoodbyeReceived}
			return result
		case sshresume.FrameAbort:
			result.ended, result.end = true, sshresume.End{Kind: sshresume.EndAbortReceived, Reason: frame.Reason}
			return result
		default:
			return abort(sshresume.AbortProtocol)
		}
	}
	return result
}

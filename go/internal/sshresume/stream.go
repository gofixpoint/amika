package sshresume

import (
	"errors"
	"fmt"
	"io"
	"sync"
	"time"

	"github.com/coder/websocket"
)

// ErrEnded marks an Attach to a session that has already ended.
var ErrEnded = errors.New("ssh resume session ended")

// Role is the end of the session a Stream runs.
type Role int

// Roles. The client sends PING; the server answers it with PONG.
const (
	RoleClient Role = iota + 1
	RoleServer
)

// EndKind says how a session ended.
type EndKind int

// End kinds.
const (
	// EndGoodbyeAcked: this side's source ended, it sent GOODBYE, and the
	// peer acknowledged every byte.
	EndGoodbyeAcked EndKind = iota + 1
	// EndGoodbyeReceived: the peer sent GOODBYE and this side wrote every
	// byte up to it to its sink.
	EndGoodbyeReceived
	// EndAbortReceived: the peer sent ABORT. End.Reason is the peer's.
	EndAbortReceived
	// EndAborted: this side sent ABORT. End.Reason says why.
	EndAborted
	// EndExpired: the owner gave up on a session with no transport.
	EndExpired
)

// End is how a session ended.
type End struct {
	Kind   EndKind
	Reason AbortReason
}

// Name returns a stable name for logs.
func (e End) Name() string {
	switch e.Kind {
	case EndGoodbyeAcked:
		return "goodbye_acked"
	case EndGoodbyeReceived:
		return "goodbye_received"
	case EndAbortReceived:
		return "abort_received"
	case EndAborted:
		return "aborted_" + e.Reason.name()
	case EndExpired:
		return "expired"
	default:
		return "unknown"
	}
}

func (r AbortReason) name() string {
	switch r {
	case AbortProtocol:
		return "protocol"
	case AbortStalled:
		return "stalled"
	case AbortSinkFailed:
		return "sink_failed"
	case AbortShutdown:
		return "shutdown"
	default:
		return "other"
	}
}

// Options configures a Stream. Zero fields take the defaults.
type Options struct {
	Timing Timing
	Clock  Clock
}

// Counters are a Stream's byte counts.
type Counters struct {
	// Sent is the bytes read from the source.
	Sent uint64
	// Acked is the bytes the peer has acknowledged.
	Acked uint64
	// Received is the bytes received and written to the sink.
	Received uint64
}

// Stream is one end of a resumable session. It reads its source into a replay
// buffer, writes the peer's bytes to its sink, and carries both over one
// attached Transport at a time. The source and the sink live across
// transports, so an acknowledged byte is never lost.
//
// The owner runs the handshake, then calls Attach with the peer's received
// count, and Attach again after each transport ends, until Done.
type Stream struct {
	role   Role
	timing Timing
	clock  Clock
	source io.Reader
	sink   io.Writer

	mu          sync.Mutex
	buf         replayBuffer
	highWater   uint64 // the most bytes ever transmitted
	received    uint64
	stallFrom   time.Time
	sourceEnded bool
	ended       bool
	end         End
	current     *Attachment
	// space wakes the source reader when an ack frees buffer.
	space      chan struct{}
	sourceDone chan struct{}
	done       chan struct{}
}

// NewStream starts reading source. The caller owns source and sink, and
// closes them after Done.
func NewStream(role Role, source io.Reader, sink io.Writer, options Options) *Stream {
	clock := options.Clock
	if clock == nil {
		clock = SystemClock{}
	}
	s := &Stream{
		role:       role,
		timing:     options.Timing.WithDefaults(),
		clock:      clock,
		source:     source,
		sink:       sink,
		space:      make(chan struct{}, 1),
		sourceDone: make(chan struct{}),
		done:       make(chan struct{}),
	}
	go s.readSource()
	return s
}

// Attach carries the session on t, from peerReceived: the peer's received
// count from the handshake. It must lie between the peer's last ack and the
// bytes this side has transmitted; otherwise Attach sends ABORT on t and ends
// the session. With sendWelcome, Attach first sends WELCOME status Resumed
// with this side's received count, as amikad does on a resume.
//
// The previous attachment must be Done.
func (s *Stream) Attach(t Transport, peerReceived uint64, sendWelcome bool) (*Attachment, error) {
	s.mu.Lock()
	if s.ended {
		s.mu.Unlock()
		return nil, ErrEnded
	}
	if s.current != nil {
		s.mu.Unlock()
		return nil, errors.New("ssh resume stream already attached")
	}
	if peerReceived < s.buf.start || peerReceived > s.highWater {
		s.mu.Unlock()
		s.abortOn(t, AbortProtocol)
		return nil, fmt.Errorf("%w: resume count out of range", ErrProtocol)
	}
	now := s.clock.Now()
	a := &Attachment{
		s:           s,
		t:           t,
		wake:        make(chan struct{}, 1),
		done:        make(chan struct{}),
		transmitted: peerReceived,
		ackSent:     s.received,
		lastSent:    now,
		lastRecv:    now,
		resent:      s.highWater - peerReceived,
	}
	s.ackToLocked(peerReceived)
	s.stallFrom = now
	s.current = a
	received := s.received
	s.mu.Unlock()

	if sendWelcome {
		welcome := mustMarshal(Frame{Type: FrameWelcome, Status: WelcomeResumed, Count: received})
		if err := t.WriteFrame(welcome); err != nil {
			a.drop()
		}
	}
	a.start()
	return a, nil
}

// Received returns the bytes received and written to the sink. Between
// attachments it is the count a resume handshake sends.
func (s *Stream) Received() uint64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.received
}

// Counters returns the byte counts.
func (s *Stream) Counters() Counters {
	s.mu.Lock()
	defer s.mu.Unlock()
	return Counters{Sent: s.buf.end(), Acked: s.buf.start, Received: s.received}
}

// Done is closed when the session ends.
func (s *Stream) Done() <-chan struct{} { return s.done }

// End reports how the session ended, once Done is closed.
func (s *Stream) End() (End, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.end, s.ended
}

// SourceEnded is closed when the source returns EOF or an error.
func (s *Stream) SourceEnded() <-chan struct{} { return s.sourceDone }

// Abort ends the session now, and sends ABORT with reason on the attached
// transport, if any.
func (s *Stream) Abort(reason AbortReason) {
	s.endWith(End{Kind: EndAborted, Reason: reason}, abortFrame(reason))
}

// Expire ends a session its owner has given up on. It sends nothing.
func (s *Stream) Expire() { s.endWith(End{Kind: EndExpired}, nil) }

// readSource reads the source into the replay buffer while the buffer is
// below ReplayLimit. When the buffer is full it stops reading, which is how
// backpressure reaches OpenSSH (the stdin pipe) and sshd (the TCP window).
func (s *Stream) readSource() {
	chunk := make([]byte, MaxDataBytes)
	for {
		s.mu.Lock()
		for !s.ended && s.buf.len() >= ReplayLimit {
			s.mu.Unlock()
			select {
			case <-s.space:
			case <-s.done:
			}
			s.mu.Lock()
		}
		if s.ended {
			s.mu.Unlock()
			return
		}
		room := min(MaxDataBytes, ReplayLimit-s.buf.len())
		s.mu.Unlock()

		read, err := s.source.Read(chunk[:room])

		s.mu.Lock()
		if read > 0 && !s.ended {
			s.buf.append(chunk[:read])
			if s.buf.len() >= ReplayLimit {
				s.stallFrom = s.clock.Now()
			}
			s.wakeWriterLocked()
		}
		if err != nil {
			s.sourceEnded = true
			close(s.sourceDone)
			s.wakeWriterLocked()
			s.mu.Unlock()
			return
		}
		s.mu.Unlock()
	}
}

// ackToLocked drops acknowledged bytes and wakes the source reader.
func (s *Stream) ackToLocked(offset uint64) {
	if offset == s.buf.start {
		return
	}
	s.buf.trimTo(offset)
	s.stallFrom = s.clock.Now()
	signal(s.space)
}

func (s *Stream) wakeWriterLocked() {
	if s.current != nil {
		signal(s.current.wake)
	}
}

// fail ends the session because of this side's own finding, and tells the
// peer with ABORT.
func (s *Stream) fail(reason AbortReason) { s.Abort(reason) }

// abortOn ends the session and sends ABORT on a transport that was never
// attached.
func (s *Stream) abortOn(t Transport, reason AbortReason) {
	s.endWith(End{Kind: EndAborted, Reason: reason}, nil)
	writeFinal(t, abortFrame(reason))
	t.Close(websocket.StatusNormalClosure)
}

// endWith ends the session once. It sends final, if any, on the attached
// transport, then closes that transport normally.
func (s *Stream) endWith(end End, final []byte) {
	s.mu.Lock()
	if s.ended {
		s.mu.Unlock()
		return
	}
	s.ended = true
	s.end = end
	close(s.done)
	a := s.current
	if a != nil && !a.beginCloseLocked(DetachEnded) {
		a = nil
	}
	s.mu.Unlock()
	if a == nil {
		return
	}
	if final != nil {
		writeFinal(a.t, final)
	}
	a.t.Close(websocket.StatusNormalClosure)
}

// finalWriteWait bounds the write of a last frame to a transport that may no
// longer be read.
const finalWriteWait = time.Second

func writeFinal(t Transport, frame []byte) {
	written := make(chan struct{})
	go func() {
		defer close(written)
		_ = t.WriteFrame(frame)
	}()
	timer := time.NewTimer(finalWriteWait)
	defer timer.Stop()
	select {
	case <-written:
	case <-timer.C:
	}
}

func abortFrame(reason AbortReason) []byte {
	return mustMarshal(Frame{Type: FrameAbort, Reason: reason})
}

func signal(ch chan struct{}) {
	select {
	case ch <- struct{}{}:
	default:
	}
}

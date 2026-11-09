package sshresume

import (
	"encoding/binary"
	"slices"
	"sync"
	"time"

	"github.com/coder/websocket"
)

// DetachCause says why an attachment ended.
type DetachCause int

// Detach causes.
const (
	// DetachDropped: the transport failed, or went silent for DeadAfter.
	DetachDropped DetachCause = iota + 1
	// DetachReplaced: the owner replaced the transport (a takeover).
	DetachReplaced
	// DetachEnded: the session ended while the attachment carried it. Check
	// Stream.End.
	DetachEnded
)

// Attachment is one Transport carrying a Stream. Its reader writes the peer's
// DATA to the sink; its writer sends the replay buffer, acknowledgements,
// liveness frames and GOODBYE.
type Attachment struct {
	s    *Stream
	t    Transport
	wake chan struct{}
	done chan struct{}

	// Guarded by s.mu.
	transmitted   uint64
	ackSent       uint64
	ackDue        bool
	ackTimerArmed bool
	pongDue       bool
	pongNonce     uint64
	pingDue       bool
	pingNonce     uint64
	goodbyeQueued bool
	goodbyeSent   bool
	inSinkWrite   bool
	lastSent      time.Time
	lastRecv      time.Time
	closing       bool
	cause         DetachCause
	resent        uint64
	deadTimer     Timer
	stallTimer    Timer
	pingTimer     Timer
	ackTimer      Timer
}

// Done is closed when the attachment's reader and writer have stopped and the
// Stream can be attached again.
func (a *Attachment) Done() <-chan struct{} { return a.done }

// Cause reports why the attachment ended, once Done is closed. A transport
// that dropped first reports DetachDropped even if its session ended later.
func (a *Attachment) Cause() DetachCause {
	a.s.mu.Lock()
	defer a.s.mu.Unlock()
	return a.cause
}

// Resent is the bytes this side transmits again on this attachment: those it
// had transmitted before that the peer had not received.
func (a *Attachment) Resent() uint64 { return a.resent }

// UnackedReceived is the bytes this side had received but not yet
// acknowledged on this attachment.
func (a *Attachment) UnackedReceived() uint64 {
	a.s.mu.Lock()
	defer a.s.mu.Unlock()
	return a.s.received - a.ackSent
}

// Replace closes the transport with CloseTakeover and waits until the
// attachment is Done.
func (a *Attachment) Replace() {
	a.s.mu.Lock()
	closing := a.beginCloseLocked(DetachReplaced)
	a.s.mu.Unlock()
	if closing {
		a.t.Close(CloseTakeover)
	}
	<-a.done
}

func (a *Attachment) start() {
	s := a.s
	s.mu.Lock()
	a.deadTimer = s.clock.AfterFunc(s.timing.DeadAfter, a.checkDead)
	a.stallTimer = s.clock.AfterFunc(s.timing.ResumeGrace, a.checkStall)
	if s.role == RoleClient {
		a.pingTimer = s.clock.AfterFunc(s.timing.PingInterval, a.checkPing)
	}
	s.mu.Unlock()

	var running sync.WaitGroup
	running.Add(2)
	go func() {
		defer running.Done()
		a.readLoop()
	}()
	go func() {
		defer running.Done()
		a.writeLoop()
	}()
	go func() {
		running.Wait()
		a.finish()
	}()
}

func (a *Attachment) finish() {
	s := a.s
	s.mu.Lock()
	a.closing = true
	for _, timer := range []Timer{a.deadTimer, a.stallTimer, a.pingTimer, a.ackTimer} {
		if timer != nil {
			timer.Stop()
		}
	}
	if s.current == a {
		s.current = nil
	}
	s.mu.Unlock()
	close(a.done)
}

// drop ends the transport but not the session.
func (a *Attachment) drop() {
	a.s.mu.Lock()
	closing := a.beginCloseLocked(DetachDropped)
	a.s.mu.Unlock()
	if closing {
		a.t.Close(websocket.StatusGoingAway)
	}
}

func (a *Attachment) beginCloseLocked(cause DetachCause) bool {
	if a.closing {
		return false
	}
	a.closing = true
	a.cause = cause
	signal(a.wake)
	return true
}

// readLoop handles the peer's frames in order. It writes each DATA to the sink
// before it reads the next frame, so the receiver needs no buffer of its own.
func (a *Attachment) readLoop() {
	for {
		message, err := a.t.ReadFrame()
		if err != nil {
			a.drop()
			return
		}
		a.s.mu.Lock()
		closing := a.closing
		a.lastRecv = a.s.clock.Now()
		a.s.mu.Unlock()
		if closing {
			return
		}
		frame, err := ParseFrame(message)
		if err != nil || !a.handle(frame) {
			if err != nil {
				a.s.fail(AbortProtocol)
			}
			return
		}
	}
}

// handle applies one frame, and reports whether the reader should go on.
func (a *Attachment) handle(frame Frame) bool {
	s := a.s
	switch frame.Type {
	case FrameData:
		return a.handleData(frame)
	case FrameAck:
		return a.applyAck(frame.Ack)
	case FramePing:
		if s.role != RoleServer {
			s.fail(AbortProtocol)
			return false
		}
		s.mu.Lock()
		a.pongDue = true
		a.pongNonce = frame.Nonce
		signal(a.wake)
		s.mu.Unlock()
		return true
	case FramePong:
		if s.role != RoleClient {
			s.fail(AbortProtocol)
			return false
		}
		return a.applyAck(frame.Ack)
	case FrameGoodbye:
		s.mu.Lock()
		complete := frame.Count == s.received
		received := s.received
		s.mu.Unlock()
		if !complete {
			s.fail(AbortProtocol)
			return false
		}
		s.endWith(End{Kind: EndGoodbyeReceived}, mustMarshal(Frame{Type: FrameAck, Ack: received}))
		return false
	case FrameAbort:
		s.endWith(End{Kind: EndAbortReceived, Reason: frame.Reason}, nil)
		return false
	default:
		// HELLO and WELCOME belong to the handshake, before Attach.
		s.fail(AbortProtocol)
		return false
	}
}

func (a *Attachment) handleData(frame Frame) bool {
	s := a.s
	s.mu.Lock()
	if frame.Offset != s.received {
		s.mu.Unlock()
		s.fail(AbortProtocol)
		return false
	}
	valid, finished := a.ackLocked(frame.Ack)
	if !valid {
		s.mu.Unlock()
		s.fail(AbortProtocol)
		return false
	}
	if finished {
		s.mu.Unlock()
		s.endWith(End{Kind: EndGoodbyeAcked}, nil)
		return false
	}
	a.inSinkWrite = true
	s.mu.Unlock()

	_, err := s.sink.Write(frame.Payload)

	s.mu.Lock()
	a.inSinkWrite = false
	a.lastRecv = s.clock.Now()
	if err == nil {
		s.received += uint64(len(frame.Payload))
		a.scheduleAckLocked()
	}
	s.mu.Unlock()
	if err != nil {
		s.fail(AbortSinkFailed)
		return false
	}
	return true
}

func (a *Attachment) applyAck(ack uint64) bool {
	s := a.s
	s.mu.Lock()
	valid, finished := a.ackLocked(ack)
	s.mu.Unlock()
	switch {
	case !valid:
		s.fail(AbortProtocol)
		return false
	case finished:
		s.endWith(End{Kind: EndGoodbyeAcked}, nil)
		return false
	default:
		return true
	}
}

// ackLocked applies the peer's ack. An ack never decreases, and never passes
// what this side transmitted on this transport: a peer that acknowledges
// bytes it was never sent must not empty the replay buffer. finished reports
// that this side's GOODBYE is acknowledged.
func (a *Attachment) ackLocked(ack uint64) (valid, finished bool) {
	s := a.s
	if ack < s.buf.start || ack > a.transmitted {
		return false, false
	}
	s.ackToLocked(ack)
	return true, a.goodbyeSent && s.buf.len() == 0
}

// scheduleAckLocked sends an ACK at once after AckBytes unacknowledged
// bytes, or AckDelay after the first one.
func (a *Attachment) scheduleAckLocked() {
	s := a.s
	if s.received-a.ackSent >= AckBytes {
		a.ackDue = true
		signal(a.wake)
		return
	}
	if !a.ackTimerArmed && !a.closing {
		a.ackTimerArmed = true
		a.ackTimer = s.clock.AfterFunc(s.timing.AckDelay, a.ackTimerFired)
	}
}

func (a *Attachment) ackTimerFired() {
	s := a.s
	s.mu.Lock()
	defer s.mu.Unlock()
	a.ackTimerArmed = false
	if s.received > a.ackSent {
		a.ackDue = true
		signal(a.wake)
	}
}

// writeLoop sends frames until the attachment closes.
func (a *Attachment) writeLoop() {
	buffer := make([]byte, 0, MaxFrameBytes)
	for {
		a.s.mu.Lock()
		if a.closing {
			a.s.mu.Unlock()
			return
		}
		frame, isGoodbye := a.nextFrameLocked(buffer[:0])
		a.s.mu.Unlock()
		if frame == nil {
			<-a.wake
			continue
		}
		if err := a.t.WriteFrame(frame); err != nil {
			a.drop()
			return
		}
		a.s.mu.Lock()
		a.lastSent = a.s.clock.Now()
		finished := false
		if isGoodbye {
			a.goodbyeSent = true
			finished = a.s.buf.len() == 0
		}
		a.s.mu.Unlock()
		if finished {
			a.s.endWith(End{Kind: EndGoodbyeAcked}, nil)
			return
		}
	}
}

// nextFrameLocked encodes the next frame to send into buffer, or returns nil
// when there is nothing to send. Every DATA and PONG carries the current ack.
func (a *Attachment) nextFrameLocked(buffer []byte) (frame []byte, isGoodbye bool) {
	s := a.s
	switch {
	case a.pongDue:
		a.pongDue = false
		a.ackSent = s.received
		return mustAppend(buffer, Frame{Type: FramePong, Nonce: a.pongNonce, Ack: s.received}), false
	case a.transmitted < s.buf.end():
		frame = appendData(buffer, &s.buf, a.transmitted, s.received)
		a.ackSent = s.received
		a.transmitted += uint64(len(frame) - dataHeaderBytes)
		s.highWater = max(s.highWater, a.transmitted)
		return frame, false
	case s.sourceEnded && !a.goodbyeQueued:
		a.goodbyeQueued = true
		return mustAppend(buffer, Frame{Type: FrameGoodbye, Count: s.buf.end()}), true
	case s.received > a.ackSent && (a.ackDue || s.received-a.ackSent >= AckBytes):
		a.ackDue = false
		a.ackSent = s.received
		return mustAppend(buffer, Frame{Type: FrameAck, Ack: s.received}), false
	case a.pingDue:
		a.pingDue = false
		a.pingNonce++
		return mustAppend(buffer, Frame{Type: FramePing, Nonce: a.pingNonce}), false
	default:
		return nil, false
	}
}

const dataHeaderBytes = 1 + 8 + 8

// appendData encodes a DATA frame of the buffered bytes from offset, without
// copying them twice.
func appendData(buffer []byte, replay *replayBuffer, offset, ack uint64) []byte {
	buffer = append(buffer, byte(FrameData))
	buffer = binary.BigEndian.AppendUint64(buffer, offset)
	buffer = binary.BigEndian.AppendUint64(buffer, ack)
	payloadBytes := int(min(uint64(MaxDataBytes), replay.end()-offset))
	start := len(buffer)
	buffer = slices.Grow(buffer, payloadBytes)[:start+payloadBytes]
	replay.copyAt(offset, buffer[start:])
	return buffer
}

func mustAppend(buffer []byte, frame Frame) []byte {
	encoded, err := AppendFrame(buffer, frame)
	if err != nil {
		panic(err)
	}
	return encoded
}

// checkDead drops the transport after DeadAfter with no frame received. Time
// the reader spends writing to the sink does not count: the reader is not
// reading then.
func (a *Attachment) checkDead() {
	s := a.s
	s.mu.Lock()
	if a.closing {
		s.mu.Unlock()
		return
	}
	idle := s.clock.Now().Sub(a.lastRecv)
	if a.inSinkWrite || idle < s.timing.DeadAfter {
		wait := s.timing.DeadAfter - idle
		if a.inSinkWrite {
			wait = s.timing.DeadAfter
		}
		a.deadTimer = s.clock.AfterFunc(wait, a.checkDead)
		s.mu.Unlock()
		return
	}
	s.mu.Unlock()
	a.drop()
}

// checkPing makes the client send PING after PingInterval with no frame sent.
func (a *Attachment) checkPing() {
	s := a.s
	s.mu.Lock()
	defer s.mu.Unlock()
	if a.closing {
		return
	}
	idle := s.clock.Now().Sub(a.lastSent)
	wait := s.timing.PingInterval - idle
	if idle >= s.timing.PingInterval {
		a.pingDue = true
		signal(a.wake)
		wait = s.timing.PingInterval
	}
	a.pingTimer = s.clock.AfterFunc(wait, a.checkPing)
}

// checkStall ends the session when the replay buffer has been full, with no
// acknowledgement, for ResumeGrace on a live transport: a peer that never
// acknowledges is treated as one that is gone.
func (a *Attachment) checkStall() {
	s := a.s
	s.mu.Lock()
	if a.closing {
		s.mu.Unlock()
		return
	}
	wait := s.timing.ResumeGrace
	if s.buf.len() >= ReplayLimit {
		stalled := s.clock.Now().Sub(s.stallFrom)
		if stalled >= s.timing.ResumeGrace {
			s.mu.Unlock()
			s.fail(AbortStalled)
			return
		}
		wait -= stalled
	}
	a.stallTimer = s.clock.AfterFunc(wait, a.checkStall)
	s.mu.Unlock()
}

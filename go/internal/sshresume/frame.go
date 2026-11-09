package sshresume

import (
	"encoding/binary"
	"errors"
	"fmt"
)

// ErrProtocol marks a frame or a frame sequence that breaks the protocol. Its
// messages name the rule, never the frame's bytes.
var ErrProtocol = errors.New("ssh resume protocol error")

// FrameType is a frame's first byte.
type FrameType uint8

// Frame types. Each binary WebSocket message carries exactly one frame.
const (
	FrameHello   FrameType = 1
	FrameWelcome FrameType = 2
	FrameData    FrameType = 3
	FrameAck     FrameType = 4
	FramePing    FrameType = 5
	FramePong    FrameType = 6
	FrameGoodbye FrameType = 7
	FrameAbort   FrameType = 8
)

// HelloMode says whether a HELLO opens a session or resumes one.
type HelloMode uint8

// HELLO modes.
const (
	HelloNew    HelloMode = 0
	HelloResume HelloMode = 1
)

// WelcomeStatus is amikad's answer to a HELLO.
type WelcomeStatus uint8

// WELCOME statuses. After Unknown and Busy, amikad closes the transport.
const (
	WelcomeNew     WelcomeStatus = 0
	WelcomeResumed WelcomeStatus = 1
	WelcomeUnknown WelcomeStatus = 2
	WelcomeBusy    WelcomeStatus = 3
)

// AbortReason says why a side ended a session with ABORT. A receiver accepts
// any value; these are the ones this package sends.
type AbortReason uint8

// ABORT reasons.
const (
	// AbortProtocol: the peer sent a malformed frame or broke a rule.
	AbortProtocol AbortReason = 1
	// AbortStalled: the sender's buffer stayed full with no acknowledgement
	// for the grace period.
	AbortStalled AbortReason = 2
	// AbortSinkFailed: the sender could not write to its sink.
	AbortSinkFailed AbortReason = 3
	// AbortShutdown: amikad is stopping.
	AbortShutdown AbortReason = 4
)

// Frame is one decoded frame. Only the fields of its Type (and, for HELLO and
// WELCOME, its Mode or Status) are set.
type Frame struct {
	Type FrameType

	// HELLO.
	Mode HelloMode
	// WELCOME.
	Status WelcomeStatus
	// HELLO resume and WELCOME new.
	Secret Secret
	// HELLO resume and WELCOME resumed: the sender's received count.
	// GOODBYE: the sender's final sent count.
	Count uint64
	// WELCOME new.
	GraceMillis uint32
	ReplayLimit uint32
	// DATA: the stream position of Payload's first byte.
	Offset uint64
	// DATA, ACK and PONG: the sender's received count.
	Ack uint64
	// PING and PONG.
	Nonce uint64
	// ABORT.
	Reason AbortReason
	// DATA: 1 to MaxDataBytes bytes. ParseFrame aliases its input.
	Payload []byte
}

// ParseFrame decodes one message. Every frame has one exact length, so a
// frame that parses re-encodes to the same bytes.
func ParseFrame(message []byte) (Frame, error) {
	if len(message) == 0 {
		return Frame{}, frameError("empty frame")
	}
	if len(message) > MaxFrameBytes {
		return Frame{}, frameError("frame too large")
	}
	frame := Frame{Type: FrameType(message[0])}
	body := message[1:]
	switch frame.Type {
	case FrameHello:
		return parseHello(frame, body)
	case FrameWelcome:
		return parseWelcome(frame, body)
	case FrameData:
		if payloadBytes := len(body) - 16; payloadBytes < 1 || payloadBytes > MaxDataBytes {
			return Frame{}, frameError("bad DATA length")
		}
		frame.Offset = binary.BigEndian.Uint64(body)
		frame.Ack = binary.BigEndian.Uint64(body[8:])
		frame.Payload = body[16:]
		return frame, nil
	case FrameAck, FramePing, FrameGoodbye:
		if len(body) != 8 {
			return Frame{}, frameError("bad frame length")
		}
		value := binary.BigEndian.Uint64(body)
		switch frame.Type {
		case FrameAck:
			frame.Ack = value
		case FramePing:
			frame.Nonce = value
		default:
			frame.Count = value
		}
		return frame, nil
	case FramePong:
		if len(body) != 16 {
			return Frame{}, frameError("bad PONG length")
		}
		frame.Nonce = binary.BigEndian.Uint64(body)
		frame.Ack = binary.BigEndian.Uint64(body[8:])
		return frame, nil
	case FrameAbort:
		if len(body) != 1 {
			return Frame{}, frameError("bad ABORT length")
		}
		frame.Reason = AbortReason(body[0])
		return frame, nil
	default:
		return Frame{}, frameError("unknown frame type")
	}
}

func parseHello(frame Frame, body []byte) (Frame, error) {
	if len(body) < 1 {
		return Frame{}, frameError("bad HELLO length")
	}
	frame.Mode = HelloMode(body[0])
	rest := body[1:]
	switch frame.Mode {
	case HelloNew:
		if len(rest) != 0 {
			return Frame{}, frameError("bad HELLO length")
		}
	case HelloResume:
		if len(rest) != SecretBytes+8 {
			return Frame{}, frameError("bad HELLO length")
		}
		copy(frame.Secret[:], rest)
		frame.Count = binary.BigEndian.Uint64(rest[SecretBytes:])
	default:
		return Frame{}, frameError("unknown HELLO mode")
	}
	return frame, nil
}

func parseWelcome(frame Frame, body []byte) (Frame, error) {
	if len(body) < 1 {
		return Frame{}, frameError("bad WELCOME length")
	}
	frame.Status = WelcomeStatus(body[0])
	rest := body[1:]
	switch frame.Status {
	case WelcomeNew:
		if len(rest) != SecretBytes+4+4 {
			return Frame{}, frameError("bad WELCOME length")
		}
		copy(frame.Secret[:], rest)
		frame.GraceMillis = binary.BigEndian.Uint32(rest[SecretBytes:])
		frame.ReplayLimit = binary.BigEndian.Uint32(rest[SecretBytes+4:])
	case WelcomeResumed:
		if len(rest) != 8 {
			return Frame{}, frameError("bad WELCOME length")
		}
		frame.Count = binary.BigEndian.Uint64(rest)
	case WelcomeUnknown, WelcomeBusy:
		if len(rest) != 0 {
			return Frame{}, frameError("bad WELCOME length")
		}
	default:
		return Frame{}, frameError("unknown WELCOME status")
	}
	return frame, nil
}

// AppendFrame appends frame's encoding to dst. It refuses a frame ParseFrame
// would refuse.
func AppendFrame(dst []byte, frame Frame) ([]byte, error) {
	dst = append(dst, byte(frame.Type))
	switch frame.Type {
	case FrameHello:
		dst = append(dst, byte(frame.Mode))
		switch frame.Mode {
		case HelloNew:
		case HelloResume:
			dst = append(dst, frame.Secret[:]...)
			dst = binary.BigEndian.AppendUint64(dst, frame.Count)
		default:
			return nil, frameError("unknown HELLO mode")
		}
	case FrameWelcome:
		dst = append(dst, byte(frame.Status))
		switch frame.Status {
		case WelcomeNew:
			dst = append(dst, frame.Secret[:]...)
			dst = binary.BigEndian.AppendUint32(dst, frame.GraceMillis)
			dst = binary.BigEndian.AppendUint32(dst, frame.ReplayLimit)
		case WelcomeResumed:
			dst = binary.BigEndian.AppendUint64(dst, frame.Count)
		case WelcomeUnknown, WelcomeBusy:
		default:
			return nil, frameError("unknown WELCOME status")
		}
	case FrameData:
		if len(frame.Payload) == 0 || len(frame.Payload) > MaxDataBytes {
			return nil, frameError("bad DATA length")
		}
		dst = binary.BigEndian.AppendUint64(dst, frame.Offset)
		dst = binary.BigEndian.AppendUint64(dst, frame.Ack)
		dst = append(dst, frame.Payload...)
	case FrameAck:
		dst = binary.BigEndian.AppendUint64(dst, frame.Ack)
	case FramePing:
		dst = binary.BigEndian.AppendUint64(dst, frame.Nonce)
	case FramePong:
		dst = binary.BigEndian.AppendUint64(dst, frame.Nonce)
		dst = binary.BigEndian.AppendUint64(dst, frame.Ack)
	case FrameGoodbye:
		dst = binary.BigEndian.AppendUint64(dst, frame.Count)
	case FrameAbort:
		dst = append(dst, byte(frame.Reason))
	default:
		return nil, frameError("unknown frame type")
	}
	return dst, nil
}

// MarshalFrame returns frame's encoding.
func MarshalFrame(frame Frame) ([]byte, error) { return AppendFrame(nil, frame) }

// mustMarshal encodes a frame this package builds itself, whose fields are
// valid by construction.
func mustMarshal(frame Frame) []byte {
	encoded, err := MarshalFrame(frame)
	if err != nil {
		panic(err)
	}
	return encoded
}

func frameError(rule string) error { return fmt.Errorf("%w: %s", ErrProtocol, rule) }

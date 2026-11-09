package sshresume

import (
	"bytes"
	"errors"
	"fmt"
	"log/slog"
	"reflect"
	"strings"
	"testing"
)

func validFrames() []Frame {
	secret := Secret{1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32}
	return []Frame{
		{Type: FrameHello, Mode: HelloNew},
		{Type: FrameHello, Mode: HelloResume, Secret: secret, Count: 1 << 40},
		{Type: FrameWelcome, Status: WelcomeNew, Secret: secret, GraceMillis: 60_000, ReplayLimit: ReplayLimit},
		{Type: FrameWelcome, Status: WelcomeResumed, Count: 12345},
		{Type: FrameWelcome, Status: WelcomeUnknown},
		{Type: FrameWelcome, Status: WelcomeBusy},
		{Type: FrameData, Offset: 7, Ack: 9, Payload: []byte("x")},
		{Type: FrameData, Offset: 1 << 50, Ack: 1, Payload: bytes.Repeat([]byte{0xab}, MaxDataBytes)},
		{Type: FrameAck, Ack: 99},
		{Type: FramePing, Nonce: 3},
		{Type: FramePong, Nonce: 3, Ack: 4},
		{Type: FrameGoodbye, Count: 1000},
		{Type: FrameAbort, Reason: AbortProtocol},
		{Type: FrameAbort, Reason: 200},
	}
}

func TestFramesRoundTrip(t *testing.T) {
	for _, frame := range validFrames() {
		encoded, err := MarshalFrame(frame)
		if err != nil {
			t.Fatalf("marshal %d: %v", frame.Type, err)
		}
		decoded, err := ParseFrame(encoded)
		if err != nil {
			t.Fatalf("parse %d: %v", frame.Type, err)
		}
		if !reflect.DeepEqual(decoded, frame) {
			t.Fatalf("round trip of type %d changed the frame", frame.Type)
		}
	}
}

func TestParseFrameRefusesMalformedFrames(t *testing.T) {
	data := func(payloadBytes int) []byte {
		frame := append([]byte{byte(FrameData)}, make([]byte, 16)...)
		return append(frame, make([]byte, payloadBytes)...)
	}
	for name, message := range map[string][]byte{
		"empty":               nil,
		"unknown type":        {9},
		"type zero":           {0},
		"short HELLO":         {byte(FrameHello)},
		"HELLO new trailing":  {byte(FrameHello), byte(HelloNew), 0},
		"HELLO bad mode":      {byte(FrameHello), 2},
		"short HELLO resume":  append([]byte{byte(FrameHello), byte(HelloResume)}, make([]byte, SecretBytes+7)...),
		"WELCOME bad status":  {byte(FrameWelcome), 4},
		"WELCOME unknown pad": {byte(FrameWelcome), byte(WelcomeUnknown), 0},
		"empty DATA":          data(0),
		"DATA too large":      data(MaxDataBytes + 1),
		"short ACK":           {byte(FrameAck), 0, 0, 0},
		"long PING":           append([]byte{byte(FramePing)}, make([]byte, 9)...),
		"short PONG":          append([]byte{byte(FramePong)}, make([]byte, 8)...),
		"empty ABORT":         {byte(FrameAbort)},
		"over frame limit":    append([]byte{byte(FrameData)}, make([]byte, MaxFrameBytes)...),
	} {
		if _, err := ParseFrame(message); !errors.Is(err, ErrProtocol) {
			t.Errorf("%s: error = %v, want ErrProtocol", name, err)
		}
	}
}

func TestMarshalFrameRefusesWhatParseRefuses(t *testing.T) {
	for _, frame := range []Frame{
		{Type: 0},
		{Type: FrameHello, Mode: 7},
		{Type: FrameWelcome, Status: 9},
		{Type: FrameData},
		{Type: FrameData, Payload: make([]byte, MaxDataBytes+1)},
	} {
		if _, err := MarshalFrame(frame); !errors.Is(err, ErrProtocol) {
			t.Errorf("marshal of %d accepted an invalid frame", frame.Type)
		}
	}
}

// The secret must never reach a log, whatever path formats it.
func TestSecretNeverFormats(t *testing.T) {
	secret, err := NewSecret()
	if err != nil {
		t.Fatal(err)
	}
	hexSecret := fmt.Sprintf("%x", [SecretBytes]byte(secret))
	frame := Frame{Type: FrameHello, Mode: HelloResume, Secret: secret}
	var logs bytes.Buffer
	logger := slog.New(slog.NewJSONHandler(&logs, nil))
	logger.Info("x", "secret", secret, "frame", frame)
	logger.Info("y", slog.Any("secret", secret))
	formatted := []string{
		fmt.Sprint(secret), fmt.Sprintf("%v %s %x %X %q %#v", secret, secret, secret, secret, secret, secret),
		fmt.Sprintf("%v %+v %#v", frame, frame, frame), logs.String(),
	}
	for _, text := range formatted {
		if strings.Contains(strings.ToLower(text), hexSecret) || strings.Contains(text, string(secret[:])) {
			t.Fatalf("secret leaked into %q", text)
		}
	}
}

func TestSecretHashRefIsAPrefixOfTheHash(t *testing.T) {
	secret, _ := NewSecret()
	hash := secret.Hash()
	if ref := hash.Ref(); len(ref) != 16 || !strings.HasPrefix(fmt.Sprintf("%x", hash[:]), ref) {
		t.Fatalf("ref = %q", ref)
	}
	other, _ := NewSecret()
	if hash.Equal(other.Hash()) || !hash.Equal(secret.Hash()) {
		t.Fatal("Equal does not compare hashes")
	}
}

// FuzzParseFrame feeds arbitrary messages to the parser. It must never panic,
// and a message it accepts must re-encode to the same bytes: one encoding per
// frame leaves no room for two ends to read a frame differently.
func FuzzParseFrame(f *testing.F) {
	for _, frame := range validFrames() {
		encoded, _ := MarshalFrame(frame)
		f.Add(encoded)
	}
	f.Add([]byte{})
	f.Add([]byte{byte(FrameData), 0})
	f.Fuzz(func(t *testing.T, message []byte) {
		frame, err := ParseFrame(message)
		if err != nil {
			if !errors.Is(err, ErrProtocol) {
				t.Fatalf("error %v is not ErrProtocol", err)
			}
			return
		}
		encoded, err := MarshalFrame(frame)
		if err != nil {
			t.Fatalf("parsed frame does not marshal: %v", err)
		}
		if !bytes.Equal(encoded, message) {
			t.Fatalf("re-encoding changed the frame:\n in  %x\n out %x", message, encoded)
		}
	})
}

// FuzzFrameRoundTrip builds frames from arbitrary fields. A frame that
// marshals must parse back to itself.
func FuzzFrameRoundTrip(f *testing.F) {
	f.Add(uint8(3), uint8(0), uint64(1), uint64(2), uint32(3), []byte("payload"))
	f.Add(uint8(1), uint8(1), uint64(9), uint64(0), uint32(0), []byte{})
	f.Add(uint8(2), uint8(0), uint64(0), uint64(0), uint32(60_000), []byte{})
	f.Fuzz(func(t *testing.T, kind, sub uint8, a, b uint64, c uint32, payload []byte) {
		var secret Secret
		copy(secret[:], payload)
		frame := Frame{Type: FrameType(kind)}
		switch frame.Type {
		case FrameHello:
			frame.Mode = HelloMode(sub)
			if frame.Mode == HelloResume {
				frame.Secret, frame.Count = secret, a
			}
		case FrameWelcome:
			frame.Status = WelcomeStatus(sub)
			switch frame.Status {
			case WelcomeNew:
				frame.Secret, frame.GraceMillis, frame.ReplayLimit = secret, c, uint32(b)
			case WelcomeResumed:
				frame.Count = a
			}
		case FrameData:
			frame.Offset, frame.Ack, frame.Payload = a, b, payload
		case FrameAck:
			frame.Ack = a
		case FramePing:
			frame.Nonce = a
		case FramePong:
			frame.Nonce, frame.Ack = a, b
		case FrameGoodbye:
			frame.Count = a
		case FrameAbort:
			frame.Reason = AbortReason(sub)
		}
		encoded, err := MarshalFrame(frame)
		if err != nil {
			return
		}
		decoded, err := ParseFrame(encoded)
		if err != nil {
			t.Fatalf("marshalled frame does not parse: %v", err)
		}
		if !reflect.DeepEqual(decoded, frame) {
			t.Fatalf("round trip changed a frame of type %d", kind)
		}
	})
}

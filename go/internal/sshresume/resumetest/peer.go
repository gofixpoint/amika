package resumetest

import (
	"testing"
	"time"

	"github.com/gofixpoint/amika/go/internal/sshresume"
)

// Peer plays one side of a session frame by frame, so a test can break the
// rules on purpose.
type Peer struct {
	T   testing.TB
	End *End
}

// Send writes one frame.
func (p Peer) Send(frame sshresume.Frame) {
	p.T.Helper()
	encoded, err := sshresume.MarshalFrame(frame)
	if err != nil {
		p.T.Fatal(err)
	}
	if err := p.End.WriteFrame(encoded); err != nil {
		p.T.Fatalf("write: %v", err)
	}
}

// Next returns the next frame of type want, skipping others. It fails the
// test if none comes within 10 s.
func (p Peer) Next(want sshresume.FrameType) sshresume.Frame {
	p.T.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for {
		message, err := p.End.ReadFrameWithin(time.Until(deadline))
		if err != nil {
			p.T.Fatalf("read while waiting for frame type %d: %v", want, err)
		}
		frame, err := sshresume.ParseFrame(message)
		if err != nil {
			p.T.Fatalf("parse: %v", err)
		}
		if frame.Type == want {
			return frame
		}
	}
}

// Closed waits up to 10 s for the other end to close, and returns its code.
// Frames still in flight are skipped.
func (p Peer) Closed() error {
	p.T.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for {
		_, err := p.End.ReadFrameWithin(time.Until(deadline))
		if err == ErrReadTimeout {
			p.T.Fatal("the other end did not close")
		}
		if err != nil {
			return err
		}
	}
}

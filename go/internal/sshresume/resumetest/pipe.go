package resumetest

import (
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/coder/websocket"
	"github.com/gofixpoint/amika/go/internal/sshresume"
)

// ErrCut is the error both ends of a cut pipe return.
var ErrCut = errors.New("resumetest: transport cut")

// ClosedError is what a ReadFrame returns after the peer closed its end and
// every frame it wrote before has been read.
type ClosedError struct{ Code websocket.StatusCode }

func (e ClosedError) Error() string { return fmt.Sprintf("resumetest: closed with %d", e.Code) }

// Fault says where a pipe fails. Byte counts are the total frame bytes both
// ends have written; a negative count never triggers.
type Fault struct {
	// CutAt drops the frame that holds this byte and every frame still in
	// flight, then fails both ends, as a reset connection does.
	CutAt int64
	// SilentAt swallows the frame that holds this byte and every later
	// frame, and blocks every read until the pipe closes, as a black-holed
	// path does.
	SilentAt int64
}

// NoFault never fails.
var NoFault = Fault{CutAt: -1, SilentAt: -1}

// Pipe returns two connected transports: a client end and a server end.
// WriteFrame is safe from many goroutines; ReadFrame from one.
func Pipe(fault Fault) (client, server *End) {
	p := &pipe{fault: fault, cut: make(chan struct{}), silent: make(chan struct{})}
	toServer := newDirection()
	toClient := newDirection()
	client = &End{pipe: p, in: toClient, out: toServer}
	server = &End{pipe: p, in: toServer, out: toClient}
	return client, server
}

type pipe struct {
	fault      Fault
	mu         sync.Mutex
	written    int64
	cut        chan struct{}
	cutOnce    sync.Once
	silent     chan struct{}
	silentOnce sync.Once
}

// direction carries one end's frames to the other. closed is closed when the
// writing end closes; code is its close code.
type direction struct {
	frames    chan []byte
	closed    chan struct{}
	closeOnce sync.Once
	code      websocket.StatusCode
}

func newDirection() *direction {
	return &direction{frames: make(chan []byte, 64), closed: make(chan struct{})}
}

// End is one end of a Pipe.
type End struct {
	pipe *pipe
	in   *direction
	out  *direction
}

var _ sshresume.Transport = (*End)(nil)

// ErrReadTimeout is what ReadFrameWithin returns when no frame came in time.
var ErrReadTimeout = errors.New("resumetest: read timed out")

// ReadFrame returns the peer's next frame.
func (e *End) ReadFrame() ([]byte, error) { return e.read(nil) }

// ReadFrameWithin is ReadFrame that gives up after d.
func (e *End) ReadFrameWithin(d time.Duration) ([]byte, error) {
	timer := time.NewTimer(d)
	defer timer.Stop()
	return e.read(timer.C)
}

func (e *End) read(timeout <-chan time.Time) ([]byte, error) {
	select {
	case <-e.pipe.cut:
		return nil, ErrCut
	case <-e.out.closed:
		return nil, endError("read after close")
	default:
	}
	select {
	case <-e.pipe.silent:
		return e.waitSilent(timeout)
	default:
	}
	select {
	case frame := <-e.in.frames:
		return frame, nil
	case <-timeout:
		return nil, ErrReadTimeout
	case <-e.pipe.cut:
		return nil, ErrCut
	case <-e.out.closed:
		return nil, endError("read after close")
	case <-e.pipe.silent:
		return e.waitSilent(timeout)
	case <-e.in.closed:
		select {
		case frame := <-e.in.frames:
			return frame, nil
		default:
			return nil, ClosedError{Code: e.in.code}
		}
	}
}

func (e *End) waitSilent(timeout <-chan time.Time) ([]byte, error) {
	select {
	case <-timeout:
		return nil, ErrReadTimeout
	case <-e.pipe.cut:
		return nil, ErrCut
	case <-e.out.closed:
		return nil, endError("read after close")
	case <-e.in.closed:
		return nil, ClosedError{Code: e.in.code}
	}
}

// WriteFrame sends a copy of frame, or fails or swallows it at the fault.
func (e *End) WriteFrame(frame []byte) error {
	select {
	case <-e.pipe.cut:
		return ErrCut
	case <-e.out.closed:
		return endError("write after close")
	case <-e.in.closed:
		return endError("write to closed peer")
	default:
	}
	p := e.pipe
	p.mu.Lock()
	p.written += int64(len(frame))
	last := p.written - 1
	p.mu.Unlock()
	if p.fault.CutAt >= 0 && p.fault.CutAt <= last {
		p.Cut()
		return ErrCut
	}
	if p.fault.SilentAt >= 0 && p.fault.SilentAt <= last {
		p.silentOnce.Do(func() { close(p.silent) })
	}
	select {
	case <-p.silent:
		return nil
	default:
	}
	copied := append([]byte(nil), frame...)
	select {
	case e.out.frames <- copied:
		return nil
	case <-p.cut:
		return ErrCut
	case <-e.out.closed:
		return endError("write after close")
	case <-e.in.closed:
		return endError("write to closed peer")
	}
}

// Close ends this end. The peer reads the frames already written, then a
// ClosedError with code.
func (e *End) Close(code websocket.StatusCode) {
	e.out.closeOnce.Do(func() {
		e.out.code = code
		close(e.out.closed)
	})
}

// Cut fails both ends at once and drops every frame in flight.
func (e *End) Cut() { e.pipe.Cut() }

// Cut fails both ends at once and drops every frame in flight.
func (p *pipe) Cut() { p.cutOnce.Do(func() { close(p.cut) }) }

// Silence black-holes the pipe from now on.
func (e *End) Silence() { e.pipe.silentOnce.Do(func() { close(e.pipe.silent) }) }

// PeerCloseCode returns the code the other end closed with, and whether it
// has closed.
func (e *End) PeerCloseCode() (websocket.StatusCode, bool) {
	select {
	case <-e.in.closed:
		return e.in.code, true
	default:
		return 0, false
	}
}

func endError(what string) error { return errors.New("resumetest: " + what) }

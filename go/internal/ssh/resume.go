package ssh

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"math/rand/v2"
	"net/http"
	"strings"
	"time"

	"github.com/coder/websocket"
	"github.com/gofixpoint/amika/go/internal/sshresume"
)

// TransportDialer opens one frame transport to amikad's resumable route, with
// the credential sent outside argv.
type TransportDialer interface {
	DialTransport(ctx context.Context, connectURL, credential string) (sshresume.Transport, error)
}

// DialStatusError is a dial the server answered with an HTTP status instead of
// switching protocols.
type DialStatusError struct{ StatusCode int }

func (e *DialStatusError) Error() string {
	return fmt.Sprintf("WebSocket SSH handshake refused with HTTP %d", e.StatusCode)
}

// ProxyExitError ends the stdio proxy with Code, after Message on stderr.
type ProxyExitError struct {
	Code    int
	Message string
}

func (e *ProxyExitError) Error() string { return e.Message }

// ExitCode is the proxy's exit status.
func (e *ProxyExitError) ExitCode() int { return e.Code }

// errResumeUnsupported means the first dial of the resumable route found no
// such route: an amikad, or a hostd in front of it, from before resume. The
// proxy then uses /v1.
var errResumeUnsupported = errors.New("amikad has no resumable SSH route")

const (
	v1SessionsSuffix = "/v1/ssh-sessions"
	v2SessionsSuffix = "/v2/ssh-sessions"
	// goodbyeWait bounds how long the proxy waits, after stdin ends, for
	// amikad to acknowledge its GOODBYE.
	goodbyeWait = 2 * time.Second
)

// resumeBackoff is the wait before each resume dial after a drop: the first
// at once, then longer, each with full jitter.
var resumeBackoff = []time.Duration{0, 250 * time.Millisecond, 500 * time.Millisecond, time.Second, 2 * time.Second}

// resumeURL returns the resumable route beside a descriptor's /v1 route.
func resumeURL(connectURL string) (string, bool) {
	base, ok := strings.CutSuffix(connectURL, v1SessionsSuffix)
	if !ok {
		return "", false
	}
	return base + v2SessionsSuffix, true
}

// resumeProxy carries OpenSSH's standard I/O over amikad's resumable route,
// and resumes the session after a drop within amikad's grace period.
type resumeProxy struct {
	dialer     TransportDialer
	url        string
	credential string
	timing     sshresume.Timing
	clock      sshresume.Clock
	// jitter returns a random wait in [0, d].
	jitter func(d time.Duration) time.Duration
	events *slog.Logger
}

func newResumeProxy(dialer TransportDialer, url, credential string, events *slog.Logger) *resumeProxy {
	return &resumeProxy{
		dialer:     dialer,
		url:        url,
		credential: credential,
		timing:     sshresume.Timing{}.WithDefaults(),
		clock:      sshresume.SystemClock{},
		jitter:     func(d time.Duration) time.Duration { return time.Duration(rand.Int64N(int64(d) + 1)) },
		events:     events,
	}
}

// run carries one session until it ends. It returns errResumeUnsupported,
// before it reads stdin, if the route does not exist; nil for an exit 0; and
// a ProxyExitError for every other end, after it closes stdout.
func (p *resumeProxy) run(ctx context.Context, stdin io.Reader, stdout io.Writer) error {
	transport, welcome, err := p.dialNew(ctx)
	if err != nil {
		return err
	}
	grace := time.Duration(welcome.GraceMillis) * time.Millisecond
	if grace <= 0 {
		grace = p.timing.ResumeGrace
	}
	timing := p.timing
	timing.ResumeGrace = grace
	session := &clientSession{
		proxy:  p,
		secret: welcome.Secret,
		ref:    welcome.Secret.Hash().Ref(),
		grace:  grace,
		stream: sshresume.NewStream(sshresume.RoleClient, stdin, stdout, sshresume.Options{Timing: timing, Clock: p.clock}),
	}
	attachment, err := session.stream.Attach(transport, 0, false)
	if err != nil {
		return p.finish(stdout, &ProxyExitError{Code: 255, Message: "amika: SSH resume protocol error"})
	}
	p.events.Info("ssh_bridge_open", slog.String("session_ref", session.ref), slog.String("mode", "resume"))
	return p.finish(stdout, session.carry(ctx, attachment))
}

// dialNew opens a session. A 404 or a 401 at this first dial is an amikad or
// a hostd from before resume: hostd's gateway asks for its host key on any
// amikad path but /v1. The same token then goes to /v1, so falling back
// widens nothing.
func (p *resumeProxy) dialNew(ctx context.Context) (sshresume.Transport, sshresume.Frame, error) {
	transport, welcome, err := p.dial(ctx, sshresume.Frame{Type: sshresume.FrameHello, Mode: sshresume.HelloNew})
	var status *DialStatusError
	switch {
	case errors.As(err, &status) && (status.StatusCode == http.StatusNotFound || status.StatusCode == http.StatusUnauthorized):
		p.events.Info("ssh_resume_refused", slog.String("reason", "route_unsupported"), slog.Int("status", status.StatusCode))
		return nil, sshresume.Frame{}, errResumeUnsupported
	case err != nil:
		return nil, sshresume.Frame{}, errors.New("failed to connect direct SSH transport")
	}
	switch welcome.Status {
	case sshresume.WelcomeNew:
		return transport, welcome, nil
	case sshresume.WelcomeBusy:
		transport.Close(websocket.StatusNormalClosure)
		return nil, sshresume.Frame{}, errors.New("the rig has too many SSH sessions open; try again later")
	default:
		transport.Close(websocket.StatusProtocolError)
		return nil, sshresume.Frame{}, errors.New("failed to connect direct SSH transport: unexpected answer to a new session")
	}
}

// dial sends hello on a new transport and returns amikad's WELCOME. The whole
// dial, from the request to the WELCOME, is bounded by DialTimeout.
func (p *resumeProxy) dial(ctx context.Context, hello sshresume.Frame) (sshresume.Transport, sshresume.Frame, error) {
	dialCtx, cancel := context.WithTimeout(ctx, p.timing.DialTimeout)
	defer cancel()
	transport, err := p.dialer.DialTransport(dialCtx, p.url, p.credential)
	if err != nil {
		return nil, sshresume.Frame{}, err
	}
	encoded, err := sshresume.MarshalFrame(hello)
	if err != nil {
		transport.Close(websocket.StatusInternalError)
		return nil, sshresume.Frame{}, err
	}
	defer clear(encoded)
	timer := p.clock.AfterFunc(p.timing.DialTimeout, func() { transport.Close(websocket.StatusNormalClosure) })
	if err := transport.WriteFrame(encoded); err != nil {
		timer.Stop()
		transport.Close(websocket.StatusNormalClosure)
		return nil, sshresume.Frame{}, err
	}
	message, err := transport.ReadFrame()
	if !timer.Stop() {
		return nil, sshresume.Frame{}, errors.New("no WELCOME before the dial timeout")
	}
	if err != nil {
		transport.Close(websocket.StatusNormalClosure)
		return nil, sshresume.Frame{}, err
	}
	welcome, err := sshresume.ParseFrame(message)
	if err != nil || welcome.Type != sshresume.FrameWelcome {
		transport.Close(websocket.StatusProtocolError)
		return nil, sshresume.Frame{}, fmt.Errorf("%w: expected WELCOME", sshresume.ErrProtocol)
	}
	return transport, welcome, nil
}

// finish closes stdout and returns the run's result. An exit 0 is nil.
func (p *resumeProxy) finish(stdout io.Writer, result *ProxyExitError) error {
	if closer, ok := stdout.(io.Closer); ok {
		_ = closer.Close()
	}
	if result == nil {
		return nil
	}
	return result
}

// clientSession is one resumable session from the proxy's side. Only the
// proxy holds its secret, in memory.
type clientSession struct {
	proxy         *resumeProxy
	secret        sshresume.Secret
	ref           string
	grace         time.Duration
	stream        *sshresume.Stream
	resumes       int
	detachedTotal time.Duration
}

// resumeOutcome is why the proxy stopped trying to resume.
type resumeOutcome int

const (
	outcomeGaveUp resumeOutcome = iota + 1
	outcomeUnknown
	outcomeTokenRotated
	outcomeProtocol
	outcomeStdinDone
)

// carry waits on each attachment, resumes after each drop, and returns the
// exit the design's table gives once the session ends or cannot resume.
func (c *clientSession) carry(ctx context.Context, attachment *sshresume.Attachment) *ProxyExitError {
	p := c.proxy
	// After stdin ends, the stream sends GOODBYE; the proxy then waits at
	// most goodbyeWait for its ACK, across a resume if one is needed.
	sourceEnded := c.stream.SourceEnded()
	var goodbyeDeadline time.Time
	var goodbyeTimer <-chan struct{}
	stopGoodbyeTimer := func() {}
	for {
		select {
		case <-attachment.Done():
		case <-sourceEnded:
			sourceEnded = nil
			goodbyeDeadline = p.clock.Now().Add(goodbyeWait)
			goodbyeTimer, stopGoodbyeTimer = p.after(goodbyeWait)
			continue
		case <-goodbyeTimer:
			stopGoodbyeTimer()
			return c.end(outcomeStdinDone)
		case <-ctx.Done():
			stopGoodbyeTimer()
			return c.end(outcomeGaveUp)
		}
		if isDone(c.stream.Done()) {
			stopGoodbyeTimer()
			return c.end(0)
		}
		droppedAt := p.clock.Now()
		counters := c.stream.Counters()
		p.events.Info("ssh_resume_detach",
			slog.String("session_ref", c.ref),
			slog.String("reason", "dropped"),
			slog.Uint64("unacked_to_rig", counters.Sent-counters.Acked),
			slog.Uint64("unacked_from_rig", attachment.UnackedReceived()),
		)
		deadline := droppedAt.Add(c.grace)
		if !goodbyeDeadline.IsZero() && goodbyeDeadline.Before(deadline) {
			deadline = goodbyeDeadline
		}
		next, outcome := c.resume(ctx, deadline)
		if next == nil {
			stopGoodbyeTimer()
			if !goodbyeDeadline.IsZero() && outcome == outcomeGaveUp {
				outcome = outcomeStdinDone
			}
			return c.end(outcome)
		}
		detached := p.clock.Now().Sub(droppedAt)
		c.detachedTotal += detached
		c.resumes++
		p.events.Info("ssh_resume_attach",
			slog.String("session_ref", c.ref),
			slog.Int64("detached_ms", detached.Milliseconds()),
			slog.Uint64("bytes_resent_to_rig", next.Resent()),
		)
		attachment = next
	}
}

// resume dials again until amikad takes the session back, says it no longer
// has it, or the deadline passes.
func (c *clientSession) resume(ctx context.Context, deadline time.Time) (*sshresume.Attachment, resumeOutcome) {
	p := c.proxy
	for attempt := 0; ; attempt++ {
		wait := p.jitter(resumeBackoff[min(attempt, len(resumeBackoff)-1)])
		if !p.clock.Now().Add(wait).Before(deadline) {
			return nil, outcomeGaveUp
		}
		if !p.sleep(ctx, wait) {
			return nil, outcomeGaveUp
		}
		hello := sshresume.Frame{
			Type:   sshresume.FrameHello,
			Mode:   sshresume.HelloResume,
			Secret: c.secret,
			Count:  c.stream.Received(),
		}
		transport, welcome, err := p.dial(ctx, hello)
		var status *DialStatusError
		switch {
		case errors.As(err, &status) && status.StatusCode == http.StatusUnauthorized:
			p.events.Info("ssh_resume_refused", slog.String("reason", "token_rotated"))
			return nil, outcomeTokenRotated
		case errors.As(err, &status) && status.StatusCode == http.StatusNotFound:
			p.events.Info("ssh_resume_refused", slog.String("reason", "route_gone"))
			return nil, outcomeUnknown
		case err != nil:
			continue
		}
		switch welcome.Status {
		case sshresume.WelcomeResumed:
			attachment, err := c.stream.Attach(transport, welcome.Count, false)
			if err != nil {
				return nil, outcomeProtocol
			}
			return attachment, 0
		case sshresume.WelcomeUnknown:
			transport.Close(websocket.StatusNormalClosure)
			p.events.Info("ssh_resume_refused", slog.String("reason", "unknown"))
			return nil, outcomeUnknown
		case sshresume.WelcomeBusy:
			transport.Close(websocket.StatusNormalClosure)
		default:
			transport.Close(websocket.StatusProtocolError)
			return nil, outcomeProtocol
		}
	}
}

// end stops the session and applies the design's exit table: 0 when this
// side's stdin ended (OpenSSH has closed its side), or when the rig's GOODBYE
// arrived with every byte before it; 255 with one line otherwise, so a lost
// ABORT never turns into a success.
func (c *clientSession) end(outcome resumeOutcome) *ProxyExitError {
	stdinEnded := isDone(c.stream.SourceEnded())
	if !isDone(c.stream.Done()) {
		c.stream.Expire()
	}
	end, _ := c.stream.End()
	counters := c.stream.Counters()
	c.proxy.events.Info("ssh_bridge_close",
		slog.String("session_ref", c.ref),
		slog.String("mode", "resume"),
		slog.String("end", end.Name()),
		slog.Uint64("bytes_from_rig", counters.Received),
		slog.Uint64("bytes_to_rig", counters.Sent),
		slog.Int("resumes", c.resumes),
		slog.Int64("detached_total_ms", c.detachedTotal.Milliseconds()),
	)
	clear(c.secret[:])
	return exitFor(outcome, end, stdinEnded, c.grace)
}

// exitFor is the design's exit table.
func exitFor(outcome resumeOutcome, end sshresume.End, stdinEnded bool, grace time.Duration) *ProxyExitError {
	if end.Kind == sshresume.EndGoodbyeAcked || end.Kind == sshresume.EndGoodbyeReceived || stdinEnded {
		return nil
	}
	message := "amika: the SSH session ended unexpectedly"
	switch {
	case end.Kind == sshresume.EndAbortReceived:
		message = "amika: the rig ended the SSH session"
	case outcome == outcomeGaveUp:
		message = fmt.Sprintf("amika: lost the connection to the rig and could not resume the SSH session within %d s", int(grace.Seconds()))
	case outcome == outcomeUnknown:
		message = "amika: the rig no longer has this SSH session"
	case outcome == outcomeTokenRotated:
		message = "amika: the rig's connect token changed (the rig restarted), so the SSH session is gone"
	case outcome == outcomeProtocol || end.Kind == sshresume.EndAborted:
		message = "amika: SSH resume protocol error"
	}
	return &ProxyExitError{Code: 255, Message: message}
}

// after returns a channel the clock closes after d, and a stop function.
func (p *resumeProxy) after(d time.Duration) (<-chan struct{}, func()) {
	fired := make(chan struct{})
	timer := p.clock.AfterFunc(d, func() { close(fired) })
	return fired, func() { timer.Stop() }
}

// sleep waits d on the proxy's clock, and reports false if ctx ended first.
func (p *resumeProxy) sleep(ctx context.Context, d time.Duration) bool {
	if d <= 0 {
		return ctx.Err() == nil
	}
	fired, stop := p.after(d)
	defer stop()
	select {
	case <-fired:
		return true
	case <-ctx.Done():
		return false
	}
}

func isDone(ch <-chan struct{}) bool {
	select {
	case <-ch:
		return true
	default:
		return false
	}
}

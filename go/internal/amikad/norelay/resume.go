package norelay

import (
	"context"
	"log/slog"
	"net/http"
	"sync"
	"time"

	"github.com/coder/websocket"
	"github.com/gofixpoint/amika/go/internal/sshresume"
)

// ResumableSSHSessionsPath is the resumable no-relay route. It takes the same
// connect token as SSHSessionsPath, then carries sshresume frames, so one
// sshd connection outlives a dropped WebSocket for the grace period. The
// protocol is amika-mono's
// specs/035-host-connection-drops.d/end-to-end-ssh-resume.md.
const ResumableSSHSessionsPath = "/v2/ssh-sessions"

// maxPendingHellos caps the upgraded transports that have not sent HELLO yet.
// The capacity check for a new session happens at its HELLO.
const maxPendingHellos = 16

// FrameUpgrader upgrades an authenticated request into a frame transport.
type FrameUpgrader interface {
	UpgradeTransport(http.ResponseWriter, *http.Request) (sshresume.Transport, error)
}

// serveResumable reads the transport's HELLO, then opens a session or resumes
// one. It returns when the transport ends.
func (h *Handler) serveResumable(w http.ResponseWriter, request *http.Request) {
	select {
	case h.pendingHellos <- struct{}{}:
	default:
		h.refuseResume("pending_capacity")
		http.Error(w, "capacity exceeded", http.StatusTooManyRequests)
		return
	}
	transport, err := h.deps.FrameUpgrader.UpgradeTransport(w, request)
	if err != nil {
		<-h.pendingHellos
		h.refuseResume("upgrade_failed")
		return
	}
	if !h.resume.addPending(transport) {
		<-h.pendingHellos
		h.refuseResume("shutdown")
		transport.Close(websocket.StatusGoingAway)
		return
	}
	hello, refusal := h.readHello(transport)
	h.resume.removePending(transport)
	<-h.pendingHellos
	if refusal != "" {
		h.refuseResume(refusal)
		transport.Close(websocket.StatusPolicyViolation)
		return
	}
	if hello.Mode == sshresume.HelloResume {
		h.resumeSession(transport, hello)
		return
	}
	h.openSession(request.Context(), transport)
}

// readHello waits HelloTimeout for a valid HELLO. It returns a refusal reason
// for anything else.
func (h *Handler) readHello(transport sshresume.Transport) (sshresume.Frame, string) {
	timer := h.deps.Clock.AfterFunc(h.config.ResumeTiming.HelloTimeout, func() {
		transport.Close(websocket.StatusPolicyViolation)
	})
	message, err := transport.ReadFrame()
	if !timer.Stop() {
		return sshresume.Frame{}, "hello_timeout"
	}
	if err != nil {
		return sshresume.Frame{}, "closed_before_hello"
	}
	frame, err := sshresume.ParseFrame(message)
	if err != nil || frame.Type != sshresume.FrameHello {
		return sshresume.Frame{}, "bad_hello"
	}
	return frame, ""
}

// openSession takes a capacity slot, dials sshd, and hands the client a new
// session's secret in WELCOME.
func (h *Handler) openSession(ctx context.Context, transport sshresume.Transport) {
	select {
	case h.slots <- struct{}{}:
		h.active.Add(1)
	default:
		h.refuseResume("capacity")
		writeWelcome(transport, sshresume.Frame{Type: sshresume.FrameWelcome, Status: sshresume.WelcomeBusy})
		transport.Close(websocket.StatusNormalClosure)
		return
	}
	release := func() {
		<-h.slots
		h.active.Add(-1)
	}
	sshd, err := h.deps.Dialer.DialContext(ctx, "tcp", h.config.SSHDAddress)
	if err != nil {
		release()
		h.refuseResume("sshd_unreachable")
		transport.Close(websocket.StatusInternalError)
		return
	}
	secret, err := sshresume.NewSecret()
	if err != nil {
		_ = sshd.Close()
		release()
		h.refuseResume("secret_unavailable")
		transport.Close(websocket.StatusInternalError)
		return
	}
	stream := sshresume.NewStream(sshresume.RoleServer, sshd, sshd, sshresume.Options{
		Timing: h.config.ResumeTiming,
		Clock:  h.deps.Clock,
	})
	session := &resumeSession{
		hash:     secret.Hash(),
		stream:   stream,
		sshd:     sshd,
		release:  release,
		openedAt: h.deps.Clock.Now(),
	}
	if !h.resume.add(session) {
		stream.Expire()
		h.finish(session)
		transport.Close(websocket.StatusGoingAway)
		return
	}
	welcomed := writeWelcome(transport, sshresume.Frame{
		Type:        sshresume.FrameWelcome,
		Status:      sshresume.WelcomeNew,
		Secret:      secret,
		GraceMillis: uint32(h.config.ResumeTiming.ResumeGrace.Milliseconds()),
		ReplayLimit: sshresume.ReplayLimit,
	})
	clear(secret[:])
	if !welcomed {
		// The client never learned the secret, so nothing can resume this.
		stream.Expire()
		h.finish(session)
		transport.Close(websocket.StatusGoingAway)
		return
	}
	h.log("ssh_bridge_open", slog.String("session_ref", session.hash.Ref()), slog.String("mode", "resume"))

	session.mu.Lock()
	attachment, err := stream.Attach(transport, 0, false)
	session.current = attachment
	session.mu.Unlock()
	if err != nil {
		h.finish(session)
		return
	}
	h.carry(session, attachment)
}

// resumeSession attaches the transport to the session the HELLO's secret
// names. The newest valid resume wins: an attached transport is closed with
// sshresume.CloseTakeover first. A wrong secret gets the same answer as an
// ended session: Unknown.
func (h *Handler) resumeSession(transport sshresume.Transport, hello sshresume.Frame) {
	session := h.resume.find(hello.Secret.Hash())
	if session == nil {
		h.refuseUnknown(transport)
		return
	}
	session.mu.Lock()
	if isClosed(session.stream.Done()) {
		session.mu.Unlock()
		h.refuseUnknown(transport)
		return
	}
	if session.current != nil {
		session.current.Replace()
	}
	if session.grace != nil {
		session.grace.Stop()
		session.grace = nil
	}
	var detached time.Duration
	if !session.detachedAt.IsZero() {
		detached = h.deps.Clock.Now().Sub(session.detachedAt)
		session.detachedTotal += detached
		session.detachedAt = time.Time{}
	}
	attachment, err := session.stream.Attach(transport, hello.Count, true)
	if err != nil {
		session.mu.Unlock()
		h.refuseResume("bad_resume_count")
		h.finish(session)
		return
	}
	session.current = attachment
	session.resumes++
	session.mu.Unlock()
	h.log("ssh_resume_attach",
		slog.String("session_ref", session.hash.Ref()),
		slog.Int64("detached_ms", detached.Milliseconds()),
		slog.Uint64("bytes_resent_to_client", attachment.Resent()),
	)
	h.carry(session, attachment)
}

// carry waits for the attachment to end. A transport that dropped detaches
// the session and starts its grace timer; a session that ended is finished.
func (h *Handler) carry(session *resumeSession, attachment *sshresume.Attachment) {
	<-attachment.Done()
	cause := attachment.Cause()
	counters := session.stream.Counters()
	session.mu.Lock()
	ended := isClosed(session.stream.Done())
	if session.current == attachment {
		session.current = nil
		if !ended {
			session.detachedAt = h.deps.Clock.Now()
			session.grace = h.deps.Clock.AfterFunc(h.config.ResumeTiming.ResumeGrace, func() { h.expire(session) })
		}
	}
	session.mu.Unlock()
	if !ended {
		reason := "dropped"
		if cause == sshresume.DetachReplaced {
			reason = "takeover"
		}
		h.log("ssh_resume_detach",
			slog.String("session_ref", session.hash.Ref()),
			slog.String("reason", reason),
			slog.Uint64("unacked_to_client", counters.Sent-counters.Acked),
			slog.Uint64("unacked_from_client", attachment.UnackedReceived()),
		)
		return
	}
	h.finish(session)
}

// expire ends a session whose grace period passed with no resume.
func (h *Handler) expire(session *resumeSession) {
	session.mu.Lock()
	if session.current != nil || isClosed(session.stream.Done()) {
		session.mu.Unlock()
		return
	}
	session.grace = nil
	session.stream.Expire()
	session.mu.Unlock()
	h.finish(session)
}

// finish closes the session's sshd connection, frees its slot and buffers,
// and forgets it. amikad keeps no record of an ended session.
func (h *Handler) finish(session *resumeSession) {
	session.finishOnce.Do(func() {
		_ = session.sshd.Close()
		h.resume.remove(session)
		session.release()
		end, _ := session.stream.End()
		counters := session.stream.Counters()
		session.mu.Lock()
		resumes, detachedTotal := session.resumes, session.detachedTotal
		if !session.detachedAt.IsZero() {
			detachedTotal += h.deps.Clock.Now().Sub(session.detachedAt)
		}
		session.mu.Unlock()
		h.log("ssh_bridge_close",
			slog.String("session_ref", session.hash.Ref()),
			slog.String("mode", "resume"),
			slog.String("reason", closeReason(end)),
			slog.String("end", end.Name()),
			slog.Int64("duration_ms", h.deps.Clock.Now().Sub(session.openedAt).Milliseconds()),
			slog.Uint64("bytes_from_client", counters.Received),
			slog.Uint64("bytes_from_sshd", counters.Sent),
			slog.Int("resumes", resumes),
			slog.Int64("detached_total_ms", detachedTotal.Milliseconds()),
		)
	})
}

// closeResumable sends ABORT on every session's transport and closes every
// sshd connection, for daemon shutdown. Transports that wait for HELLO close.
//
// It takes no session lock: a takeover can hold one while it waits for a
// write to sshd, and closing sshd here is what ends that write. A pending
// grace timer then finds the session ended and does nothing. Sessions close
// in parallel, so each one's bounded ABORT write does not add up.
func (h *Handler) closeResumable() {
	sessions, pending := h.resume.close()
	for _, transport := range pending {
		transport.Close(websocket.StatusGoingAway)
	}
	var closing sync.WaitGroup
	for _, session := range sessions {
		closing.Go(func() {
			session.stream.Abort(sshresume.AbortShutdown)
			h.finish(session)
		})
	}
	closing.Wait()
}

func (h *Handler) refuseUnknown(transport sshresume.Transport) {
	h.refuseResume("unknown")
	writeWelcome(transport, sshresume.Frame{Type: sshresume.FrameWelcome, Status: sshresume.WelcomeUnknown})
	transport.Close(websocket.StatusNormalClosure)
}

func (h *Handler) refuseResume(reason string) {
	h.log("ssh_resume_refused", slog.String("reason", reason))
}

func writeWelcome(transport sshresume.Transport, welcome sshresume.Frame) bool {
	encoded, err := sshresume.MarshalFrame(welcome)
	if err != nil {
		return false
	}
	defer clear(encoded)
	return transport.WriteFrame(encoded) == nil
}

// closeReason maps a session's end to the bridge's close reasons.
func closeReason(end sshresume.End) string {
	switch end.Kind {
	case sshresume.EndGoodbyeReceived:
		return "client_closed"
	case sshresume.EndGoodbyeAcked:
		return "sshd_closed"
	case sshresume.EndAbortReceived:
		return "client_aborted"
	case sshresume.EndExpired:
		return "grace_expired"
	default:
		return "aborted"
	}
}

func isClosed(ch <-chan struct{}) bool {
	select {
	case <-ch:
		return true
	default:
		return false
	}
}

// resumeSession is one resumable session: one sshd connection, and the
// stream that carries it across transports.
type resumeSession struct {
	// hash is the SHA-256 of the session's secret. amikad never keeps the
	// secret itself.
	hash     sshresume.SecretHash
	stream   *sshresume.Stream
	sshd     Stream
	release  func()
	openedAt time.Time

	// mu serializes attach, detach and expiry.
	mu            sync.Mutex
	current       *sshresume.Attachment
	grace         sshresume.Timer
	detachedAt    time.Time
	detachedTotal time.Duration
	resumes       int
	finishOnce    sync.Once
}

// resumeRegistry holds the live sessions and the transports that wait for
// HELLO.
type resumeRegistry struct {
	mu       sync.Mutex
	closed   bool
	sessions map[*resumeSession]struct{}
	pending  map[sshresume.Transport]struct{}
}

func newResumeRegistry() *resumeRegistry {
	return &resumeRegistry{
		sessions: make(map[*resumeSession]struct{}),
		pending:  make(map[sshresume.Transport]struct{}),
	}
}

// find returns the session with this secret hash. It compares against every
// session in constant time, and never stops early.
func (r *resumeRegistry) find(hash sshresume.SecretHash) *resumeSession {
	r.mu.Lock()
	defer r.mu.Unlock()
	var found *resumeSession
	for session := range r.sessions {
		if session.hash.Equal(hash) {
			found = session
		}
	}
	return found
}

func (r *resumeRegistry) add(session *resumeSession) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.closed {
		return false
	}
	r.sessions[session] = struct{}{}
	return true
}

func (r *resumeRegistry) remove(session *resumeSession) {
	r.mu.Lock()
	defer r.mu.Unlock()
	delete(r.sessions, session)
}

func (r *resumeRegistry) addPending(transport sshresume.Transport) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.closed {
		return false
	}
	r.pending[transport] = struct{}{}
	return true
}

func (r *resumeRegistry) removePending(transport sshresume.Transport) {
	r.mu.Lock()
	defer r.mu.Unlock()
	delete(r.pending, transport)
}

// close refuses every later session, and returns the live ones.
func (r *resumeRegistry) close() ([]*resumeSession, []sshresume.Transport) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.closed = true
	sessions := make([]*resumeSession, 0, len(r.sessions))
	for session := range r.sessions {
		sessions = append(sessions, session)
	}
	pending := make([]sshresume.Transport, 0, len(r.pending))
	for transport := range r.pending {
		pending = append(pending, transport)
	}
	return sessions, pending
}

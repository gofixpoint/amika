/**
 * One tunnel session: the streams the relay opens, and the socket that
 * carries their frames.
 *
 * The relay opens one stream for each request or upgrade it forwards.
 * hostd opens none. That asymmetry is the protocol, and it is not a result
 * of which end dialled: a stream in the other direction would make the
 * relay carry traffic *for* a host, which is a forward proxy. Nothing here
 * can send `OPEN`, and an `OPEN` is the only frame that creates a stream.
 *
 * In `amika.tunnel.v2` a session is one WebSocket, and it ends with it. In
 * `amika.tunnel.v3` (`resume` set) the session outlives the socket. It
 * counts the frames it sends and processes, keeps the frames the relay has
 * not acknowledged, and acknowledges what it processed. When the socket
 * ends, the session detaches: every stream stays open, and the session waits
 * up to the grace for `TunnelClient` to dial again and `resume` it on a new
 * socket. Each side then resends what the other did not receive.
 *
 * A session knows nothing about dialling. `TunnelClient` decides that.
 */
import type { Duplex } from "node:stream";
import type { WebSocket } from "ws";
import {
  CLOSE_SESSION_ENDED,
  decodeFrame,
  decodeFrameV3,
  encodeAck,
  encodeFrame,
  MalformedHeadError,
  MAX_CONCURRENT_STREAMS,
  ProtocolError,
  type AckFrame,
  type Frame,
} from "@amika/tunnel-protocol";
import {
  AckSchedule,
  ReplayLog,
  type ResumeRefusal,
} from "@amika/tunnel-protocol/resume";
import {
  openStream,
  type StreamCarrier,
  type TunnelStream,
} from "./tunnel-bridge.js";
import { TunnelLink, type LinkEnd } from "./tunnel-link.js";

export interface TunnelSessionOptions {
  /** How often to ping the relay on each socket. See `TunnelLink`. */
  keepAliveIntervalMs: number;
  /** How long a ping may go unanswered before it counts as missed. */
  pingTimeoutMs: number;
  /** How many pings in a row may be missed before the socket counts as dead. */
  maxMissedPings: number;
  /** How long `close` lets streams in flight finish. */
  drainMs: number;
  /** Hand one inbound connection to whatever serves HTTP on this host. */
  onConnection: (socket: Duplex) => void;
  /** Set for `amika.tunnel.v3`: the session outlives its socket. */
  resume?: SessionResume;
}

/** How a v3 session keeps itself across a drop. */
export interface ResumeLimits {
  /** How long a detached session waits for a resume. */
  graceMs: number;
  /** The most unacknowledged bytes kept for a resend. */
  maxReplayBytes: number;
  /**
   * Upstream WebSockets pause while the log holds more than this. Their
   * messages carry no credit, so this bounds what a drop queues here.
   */
  pauseReplayBytes: number;
  /** Acknowledge after this many bytes processed. */
  ackBytes: number;
  /** Or this long after the first frame not acknowledged. */
  ackDelayMs: number;
}

export interface SessionResume extends ResumeLimits {
  /** The relay's connection id, which names the session. */
  connectionId: string;
  /** What happens to the session: each event names the connection id. */
  onEvent?: (event: SessionEvent) => void;
}

/** Why a v3 session ended. */
export type SessionEndReason =
  | "fresh_attach"
  | "grace"
  | "protocol_error"
  | "stopped";

/**
 * Why a resume did not happen. The relay's own reasons, as hostd sees them,
 * plus `refused_by_relay` when the relay started a fresh session.
 */
export type ResumeRefusalReason =
  | ResumeRefusal
  | "grace_ended"
  | "switched_off"
  | "refused_by_relay";

/**
 * The events the relay logs too, with the connection id, so the two logs
 * join. A reason never holds a frame, a header value or a close reason.
 */
export type SessionEvent =
  | {
      type: "tunnel_detached";
      connectionId: string;
      reason: string;
      openStreams: number;
      unackedFrames: number;
      unackedBytes: number;
    }
  | {
      type: "tunnel_resumed";
      connectionId: string;
      detachedMs: number;
      resentFrames: number;
    }
  | {
      type: "tunnel_resume_refused";
      connectionId: string;
      reason: ResumeRefusalReason;
    }
  | {
      type: "tunnel_session_ended";
      connectionId: string;
      reason: SessionEndReason;
    };

/**
 * The tunnel's send buffer above which streams stop producing, and below
 * which they start again. The relay cannot push back on a caller, so this
 * is what bounds how much a fast server queues on this machine.
 */
const HIGH_WATER_BYTES = 4 * 1024 * 1024;
const LOW_WATER_BYTES = 1024 * 1024;
const WRITABLE_POLL_MS = 20;

/** The v3 half of a session: counts, the replay log and the timers. */
interface ResumeState {
  readonly settings: SessionResume;
  readonly log: ReplayLog;
  readonly acks: AckSchedule;
  ackTimer?: NodeJS.Timeout;
  graceTimer?: NodeJS.Timeout;
  /** When the socket ended, while the session is detached. */
  detachedAt?: number;
}

export class TunnelSession implements StreamCarrier {
  private readonly streams = new Map<number, TunnelStream>();
  /**
   * The highest stream id the relay has opened. Ids only rise in a session,
   * so this is the whole record of which have been used: a finished stream
   * leaves `streams`, and a late frame for it must not reach a new stream
   * that reused its id.
   */
  private lastStreamId = 0;
  private readonly closeListeners = new Set<(error?: Error) => void>();
  /** The id of the stream being opened, so an early finish is not lost. */
  private opening?: { streamId: number; finished: boolean };
  /** The socket the session uses now. Unset while a v3 session is detached. */
  private link?: TunnelLink;
  private readonly resumeState?: ResumeState;
  private draining = false;
  private ended = false;
  private endError?: Error;
  private served = 0;
  /** Set while `drain` is waiting; called as each stream finishes. */
  private whenIdle?: () => void;
  private drainTimer?: NodeJS.Timeout;

  constructor(
    ws: WebSocket,
    private readonly options: TunnelSessionOptions,
  ) {
    const resume = options.resume;
    if (resume) {
      this.resumeState = {
        settings: resume,
        log: new ReplayLog(resume.maxReplayBytes),
        acks: new AckSchedule(resume.ackBytes),
      };
    }
    this.link = this.newLink(ws);
  }

  /**
   * Prove the current socket works end to end, and start watching that it
   * keeps working. Resolves with the round trip of the first ping.
   *
   * The relay authorizes before its `101`, so an open socket already means
   * an attached host. The ping proves the relay's edge answers, which is
   * what the daemon reports as ready.
   */
  acknowledge(): Promise<number> {
    if (!this.link) return Promise.reject(new Error("the tunnel is detached"));
    return this.link.acknowledge();
  }

  /** Call `listener` when this session stops working, for any reason. */
  onEnded(listener: (error?: Error) => void): void {
    if (this.ended) {
      listener(this.endError);
      return;
    }
    this.closeListeners.add(listener);
  }

  get isEnded(): boolean {
    return this.ended;
  }

  /** The socket in use now, if any. `TunnelClient` watches it end. */
  get currentLink(): TunnelLink | undefined {
    return this.link;
  }

  /** The relay's connection id, for a v3 session. */
  get connectionId(): string | undefined {
    return this.resumeState?.settings.connectionId;
  }

  /** A v3 session whose socket ended, waiting for a resume. */
  get isDetached(): boolean {
    return !this.ended && this.resumeState !== undefined && !this.link;
  }

  /** How many streams the relay has open through this session. */
  get activeConnections(): number {
    return this.streams.size;
  }

  /** How many it has opened in total, which is how a session proves it worked. */
  get servedConnections(): number {
    return this.served;
  }

  /**
   * Stop serving and let the relay know, bounding how long it takes.
   *
   * Closing the WebSocket cleanly is what releases the attachment at the
   * far end. Dropping the TCP connection instead leaves the relay routing
   * into a socket nobody reads until it presumes the host gone. A v3
   * session closes with `CLOSE_SESSION_ENDED`, so the relay ends the
   * session at once rather than keep it for a resume.
   *
   * A caller with upgraded connections -- SSH, a terminal, a service
   * WebSocket -- should destroy those first. They are long-lived by design,
   * so waiting for them always runs the drain out to its bound.
   */
  async close(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    this.link?.quiet();
    await this.drain();
    for (const stream of [...this.streams.values()]) {
      stream.abort("hostd is shutting down");
    }
    this.streams.clear();
    const link = this.link;
    if (link) {
      await link.close(
        this.resumeState ? CLOSE_SESSION_ENDED : 1001,
        "going away",
        this.options.pingTimeoutMs,
      );
    }
    this.finish(new Error("the tunnel session was closed"), "stopped");
  }

  /** Stop now, failing every stream on this session. */
  abort(error: Error, reason: SessionEndReason = "stopped"): void {
    this.draining = true;
    const link = this.link;
    this.finish(error, reason);
    link?.drop(error);
  }

  /**
   * What to send on a redial to resume this session: the connection id and
   * the received count. `undefined` unless this is a detached v3 session.
   */
  resumeOffer(): { connectionId: string; received: number } | undefined {
    const resume = this.resumeState;
    if (!resume || !this.isDetached) return undefined;
    return {
      connectionId: resume.settings.connectionId,
      // The header acknowledges everything processed so far.
      received: resume.acks.acknowledgeAll(),
    };
  }

  /**
   * Continue this session on `ws`, which the relay answered with this
   * session's id and `peerReceived`, its received count.
   *
   * Resends every frame after that count, then carries on. When the count
   * is above what this side sent, or the log no longer holds every frame
   * after it, the socket is closed with `1002` and the session ends: the
   * caller dials a fresh one.
   */
  resume(
    ws: WebSocket,
    peerReceived: number | undefined,
  ): { ok: true } | { ok: false; reason: ResumeRefusalReason } {
    const resume = this.resumeState;
    let refusal: ResumeRefusalReason | undefined;
    if (!resume || this.ended) refusal = "grace_ended";
    else if (peerReceived === undefined) refusal = "count_mismatch";
    else refusal = resume.log.refusal(peerReceived);
    if (!resume || refusal !== undefined || peerReceived === undefined) {
      const reason = refusal ?? "count_mismatch";
      // Nothing reads this socket. Its errors must not reach the process.
      ws.on("error", () => {});
      ws.close(1002, "cannot resume");
      this.emit({ type: "tunnel_resume_refused", reason });
      this.abort(
        new ProtocolError(`the tunnel session could not resume: ${reason}`),
        reason === "count_mismatch" ? "protocol_error" : "fresh_attach",
      );
      return { ok: false, reason };
    }
    const frames = resume.log.resume(peerReceived);
    clearTimeout(resume.graceTimer);
    resume.graceTimer = undefined;
    const detachedMs = Date.now() - (resume.detachedAt ?? Date.now());
    resume.detachedAt = undefined;
    this.link = this.newLink(ws);
    for (const frame of frames) this.link.send(frame);
    this.emit({
      type: "tunnel_resumed",
      detachedMs,
      resentFrames: frames.length,
    });
    return { ok: true };
  }

  // --- StreamCarrier --------------------------------------------------

  send(frame: Frame): void {
    if (this.ended) return;
    const bytes = encodeFrame(frame);
    // Counted and kept even with no socket: a resume sends it then.
    this.resumeState?.log.append(bytes);
    this.link?.send(bytes);
  }

  congested(): boolean {
    const resume = this.resumeState;
    if (resume) {
      // A detached session pauses its producers, and so does a log that
      // has grown past its bound: messages carry no credit.
      if (!this.link) return !this.ended;
      if (resume.log.bytes > resume.settings.pauseReplayBytes) return true;
    }
    return (this.link?.bufferedAmount ?? 0) > HIGH_WATER_BYTES;
  }

  writable(): Promise<void> {
    if (this.drained()) return Promise.resolve();
    // `ws` raises no event when its buffer drains, and the log shrinks on
    // an `ACK`, so this polls. It runs only while the tunnel is backed up.
    return new Promise((resolve) => {
      const timer = setInterval(() => {
        if (this.drained()) {
          clearInterval(timer);
          resolve();
        }
      }, WRITABLE_POLL_MS);
      timer.unref();
    });
  }

  finished(streamId: number): void {
    if (this.opening?.streamId === streamId) this.opening.finished = true;
    this.streams.delete(streamId);
    this.whenIdle?.();
  }

  // --- Frames ---------------------------------------------------------

  private newLink(ws: WebSocket): TunnelLink {
    const link: TunnelLink = new TunnelLink(
      ws,
      {
        keepAliveIntervalMs: this.options.keepAliveIntervalMs,
        pingTimeoutMs: this.options.pingTimeoutMs,
        maxMissedPings: this.options.maxMissedPings,
      },
      (bytes) => {
        // A replaced socket's late frames are not this session's.
        if (link === this.link) this.onFrame(bytes);
      },
      (end) => this.onLinkEnded(link, end),
    );
    return link;
  }

  private onFrame(bytes: Buffer): void {
    if (this.ended) return;
    let frame: Frame | AckFrame;
    try {
      frame = this.resumeState ? decodeFrameV3(bytes) : decodeFrame(bytes);
    } catch (error) {
      // An `OPEN` whose head breaks the schema still names its stream, and
      // the relay builds heads from public requests. Refusing that one
      // stream keeps one caller's odd URL from cutting every other stream
      // on this host. Anything less readable means a peer that is not
      // speaking this protocol.
      if (error instanceof MalformedHeadError && error.frameType === "open") {
        if (this.claimStreamId(error.streamId)) {
          this.send({
            type: "reset",
            streamId: error.streamId,
            reason: error.message,
          });
          this.processed(bytes.byteLength);
        }
        return;
      }
      this.fail(
        error instanceof Error ? error : new ProtocolError("bad frame"),
      );
      return;
    }
    if (frame.type === "ack") {
      this.onAck(frame.count);
      return;
    }
    this.dispatch(frame);
    this.processed(bytes.byteLength);
  }

  private dispatch(frame: Frame): void {
    if (frame.type === "open") {
      this.accept(frame.streamId, frame.head);
      return;
    }
    if (frame.type === "response") {
      // Only the relay asks; a host never receives an answer.
      this.send({
        type: "reset",
        streamId: frame.streamId,
        reason: "a host receives no RESPONSE",
      });
      this.streams.get(frame.streamId)?.abort("RESPONSE sent to the host");
      return;
    }
    const stream = this.streams.get(frame.streamId);
    if (stream) {
      stream.receive(frame);
      return;
    }
    // A stream this end has already finished, or never had. A late frame
    // after a reset is ordinary and dropped. `DATA` is answered, so a relay
    // that still thinks the stream is open stops sending.
    if (frame.type === "data") {
      this.send({
        type: "reset",
        streamId: frame.streamId,
        reason: "no such stream",
      });
    }
  }

  /** Serve one `OPEN`, or refuse it with a reset. */
  private accept(
    streamId: number,
    head: Parameters<typeof openStream>[1],
  ): void {
    if (!this.claimStreamId(streamId)) return;
    // A stream that arrives after shutdown started is reset rather than
    // served. The relay turns a reset into a `502`, which is truthful: this
    // host is going away and will not finish the request.
    const refusal = this.draining
      ? "hostd is shutting down"
      : this.streams.size >= MAX_CONCURRENT_STREAMS
        ? "too many streams"
        : undefined;
    if (refusal) {
      this.send({ type: "reset", streamId, reason: refusal });
      return;
    }
    this.served += 1;
    this.opening = { streamId, finished: false };
    let stream: TunnelStream;
    try {
      stream = openStream(streamId, head, this, this.options.onConnection);
    } catch (error) {
      // Node's HTTP client and `ws` validate the head as they build the
      // request, and throw synchronously. This runs inside the WebSocket's
      // message handler, so a throw that escaped would end the daemon over
      // one bad stream. The schema refuses what Node refuses; this is the
      // second lock.
      this.opening = undefined;
      this.send({
        type: "reset",
        streamId,
        reason: error instanceof Error ? error.message : "bad request head",
      });
      return;
    }
    // A stream can fail inside its own constructor, a head with no host for
    // one, and report that before it was ever recorded here.
    if (!this.opening.finished) this.streams.set(streamId, stream);
    this.opening = undefined;
  }

  /**
   * Record the id of an `OPEN`, served or refused, or end the session for
   * one that does not rise. Returns whether the session carries on.
   */
  private claimStreamId(streamId: number): boolean {
    if (streamId <= this.lastStreamId) {
      // Ids rise and are never reused in a session, so this peer is
      // confused about which stream is which, and nothing it sends can be
      // trusted.
      this.fail(
        new ProtocolError(
          `stream ${streamId} opened after stream ${this.lastStreamId}`,
        ),
      );
      return false;
    }
    this.lastStreamId = streamId;
    return true;
  }

  // --- v3: acknowledgements -------------------------------------------

  /** The relay acknowledged `count` frames. A bad count ends the session. */
  private onAck(count: number): void {
    try {
      this.resumeState?.log.acknowledge(count);
    } catch (error) {
      this.fail(error instanceof Error ? error : new ProtocolError("bad ACK"));
    }
  }

  /**
   * Count one processed frame, and acknowledge on schedule: at once after
   * `ackBytes`, else `ackDelayMs` after the first frame not acknowledged.
   */
  private processed(byteLength: number): void {
    const resume = this.resumeState;
    if (!resume || this.ended) return;
    const due = resume.acks.processed(byteLength);
    switch (due) {
      case "now":
        this.sendAck();
        return;
      case "arm":
        resume.ackTimer = setTimeout(
          () => this.sendAck(),
          resume.settings.ackDelayMs,
        );
        resume.ackTimer.unref();
        return;
      case "wait":
        return;
      default:
        assertNever(due);
    }
  }

  private sendAck(): void {
    const resume = this.resumeState;
    if (!resume) return;
    clearTimeout(resume.ackTimer);
    resume.ackTimer = undefined;
    // Detached, the resume header carries the count instead.
    if (!this.link) return;
    const count = resume.acks.take();
    if (count !== undefined) this.link.send(encodeAck(count));
  }

  // --- Ending ---------------------------------------------------------

  /**
   * A socket ended. A v2 session ends with it. A v3 session detaches and
   * waits for a resume, unless the socket ended because the session did: a
   * protocol error, a shutdown, or a relay that closed the session itself.
   */
  private onLinkEnded(link: TunnelLink, end: LinkEnd): void {
    if (link !== this.link) return;
    this.link = undefined;
    const resume = this.resumeState;
    if (!resume) {
      this.finish(end.error);
      return;
    }
    clearTimeout(resume.ackTimer);
    resume.ackTimer = undefined;
    const protocolError =
      end.error instanceof ProtocolError || end.code === 1002;
    if (this.draining || protocolError || end.code === CLOSE_SESSION_ENDED) {
      this.finish(end.error, protocolError ? "protocol_error" : "stopped");
      return;
    }
    this.detach(resume, end);
  }

  /** Keep every stream, and wait up to the grace for a resume. */
  private detach(resume: ResumeState, end: LinkEnd): void {
    resume.detachedAt = Date.now();
    resume.graceTimer = setTimeout(
      () =>
        this.finish(
          new Error(
            `the tunnel did not resume within ${resume.settings.graceMs}ms`,
          ),
          "grace",
        ),
      resume.settings.graceMs,
    );
    resume.graceTimer.unref();
    this.emit({
      type: "tunnel_detached",
      reason: end.summary,
      openStreams: this.streams.size,
      unackedFrames: resume.log.frames,
      unackedBytes: resume.log.bytes,
    });
  }

  /** A peer that broke the protocol: end the session, and say why. */
  private fail(error: Error): void {
    if (this.ended) return;
    if (!this.resumeState) {
      this.abort(error);
      return;
    }
    this.draining = true;
    const link = this.link;
    this.link = undefined;
    this.finish(error, "protocol_error");
    // `1002` tells the relay to end the session too, not keep it for a
    // resume. Bounded: a peer that never answers the close is cut off.
    void link?.close(1002, "protocol error", this.options.pingTimeoutMs);
  }

  /** Whether producers may go on: the opposite of `congested`, with slack. */
  private drained(): boolean {
    if (this.ended) return true;
    const resume = this.resumeState;
    if (resume) {
      if (!this.link) return false;
      if (resume.log.bytes > resume.settings.pauseReplayBytes / 2) {
        return false;
      }
    }
    return (this.link?.bufferedAmount ?? 0) <= LOW_WATER_BYTES;
  }

  /** Wait for the streams in flight, up to `drainMs`. */
  private async drain(): Promise<void> {
    if (this.streams.size === 0) return;
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(this.drainTimer);
        this.whenIdle = undefined;
        resolve();
      };
      this.drainTimer = setTimeout(done, this.options.drainMs);
      this.drainTimer.unref();
      this.whenIdle = () => {
        if (this.streams.size === 0 || this.ended) done();
      };
    });
  }

  /** Idempotent: several events can describe one disconnect. */
  private finish(error?: Error, reason: SessionEndReason = "stopped"): void {
    if (this.ended) return;
    this.ended = true;
    this.endError = error;
    const resume = this.resumeState;
    if (resume) {
      clearTimeout(resume.ackTimer);
      clearTimeout(resume.graceTimer);
    }
    for (const stream of [...this.streams.values()]) {
      stream.abort(error?.message ?? "the tunnel ended");
    }
    this.streams.clear();
    this.whenIdle?.();
    const link = this.link;
    this.link = undefined;
    link?.closeSoon(resume ? CLOSE_SESSION_ENDED : 1001, "");
    if (resume) this.emit({ type: "tunnel_session_ended", reason });
    for (const listener of this.closeListeners) listener(error);
    this.closeListeners.clear();
  }

  private emit(event: DistributiveOmit<SessionEvent, "connectionId">): void {
    const resume = this.resumeState;
    if (!resume?.settings.onEvent) return;
    try {
      resume.settings.onEvent({
        ...event,
        connectionId: resume.settings.connectionId,
      } as SessionEvent);
    } catch {
      // A listener must not reach the session's own control flow.
    }
  }
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, K>
  : never;

function assertNever(value: never): never {
  throw new Error(`Unhandled case: ${String(value)}`);
}

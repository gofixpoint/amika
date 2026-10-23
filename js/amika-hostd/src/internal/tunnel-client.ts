/**
 * Keeping this host attached to the gateway, for as long as the daemon runs.
 *
 * One attachment at a time, dialled out from here, redialled when it ends.
 * A laptop sleeps, a network changes, a gateway deploys: none of those is an
 * error, and none of them may become a hot loop or a fleet of hosts
 * arriving in step. Three things decide what happens after a disconnect.
 *
 * **Was it a refusal or an outage.** A refusal is final until an operator
 * acts, so the loop stops and says so. An outage is not, so the loop waits
 * and dials again. `tunnel-dial.ts` makes that split from the gateway's HTTP
 * status, exactly as the gateway makes it from the control plane's answer.
 *
 * **Has the credential moved on.** A rotation or a revocation advances this
 * host's generation. A session attached under an older one must stop rather
 * than linger, and a daemon that re-reads an older credential afterwards
 * must not dial with it. `highestGeneration` is the record of that, and it
 * only ever rises.
 *
 * **Did the last session work.** A session that served traffic for a while
 * resets the schedule, so a nightly sleep does not inherit yesterday's cap.
 * A run of sessions that connected and immediately died is the shape a
 * refused attachment has on the wire today, so the loop counts those and
 * tells the operator what it suspects rather than retrying in silence.
 */
import {
  TunnelAttachment,
  type TunnelLimits,
  type TunnelAttachmentOptions,
} from "./tunnel-attachment.js";
import {
  Backoff,
  DEFAULT_BACKOFF,
  type BackoffOptions,
} from "./tunnel-backoff.js";
import {
  dialTunnel,
  TunnelRejected,
  TunnelUnavailable,
  type TunnelTarget,
} from "./tunnel-dial.js";

/**
 * As much of a live attachment as this loop needs. The loop decides policy
 * -- when to dial, when to wait, when to give up -- and knows nothing about
 * WebSockets or multiplexers, so a test can drive every branch below
 * without a socket.
 */
export interface OpenAttachment {
  acknowledge(): Promise<number>;
  onEnded(listener: (error?: Error) => void): void;
  close(): Promise<void>;
  abort(error: Error): void;
  readonly servedConnections: number;
  /** The gateway's id for this session, where the gateway reports one. */
  readonly connectionId?: string;
  /** The public address Amika assigned this host, where it reports one. */
  readonly publicUrl?: string;
}

export interface AttachedInfo {
  hostId: string;
  /** The gateway's id for this session, where the gateway reports one. */
  connectionId?: string;
  /** The public address Amika assigned this host, where the gateway sends it. */
  publicUrl?: string;
  /** The round trip of the ping that proved the tunnel works. */
  rttMs: number;
}

export type TunnelStatus =
  | { state: "starting" }
  | { state: "dialing"; attempt: number }
  | { state: "attached"; since: number; info: AttachedInfo }
  | { state: "waiting"; attempt: number; delayMs: number; reason: string }
  /** The gateway refused this host. Nothing is retried until an operator acts. */
  | { state: "rejected"; reason: string }
  | { state: "stopped" };

export type TunnelEvent =
  | { type: "dialing"; url: string; attempt: number }
  | { type: "attached"; info: AttachedInfo }
  | {
      type: "detached";
      uptimeMs: number;
      servedConnections: number;
      reason: string;
    }
  | { type: "waiting"; attempt: number; delayMs: number; reason: string }
  | { type: "rejected"; reason: string }
  /**
   * Several sessions in a row connected and died without serving anything.
   * The gateway cannot say "refused" after it has accepted the WebSocket,
   * so this is the daemon saying what the pattern looks like.
   */
  | { type: "suspect-credential"; consecutiveShortSessions: number }
  | { type: "stopped" };

export interface TunnelClientOptions extends Pick<
  TunnelAttachmentOptions,
  "keepAliveIntervalMs" | "pingTimeoutMs" | "drainMs" | "onConnection"
> {
  /**
   * Where to attach, and with what. Read again before **every** dial, so a
   * credential rotated while the daemon runs is picked up on the next
   * attempt without a restart.
   */
  target: () => TunnelTarget | Promise<TunnelTarget>;
  limits?: TunnelLimits;
  backoff?: BackoffOptions;
  handshakeTimeoutMs: number;
  userAgent: string;
  /**
   * A session shorter than this, that served nothing, counts as a failure
   * to attach rather than as a disconnect.
   */
  settleMs?: number;
  /** How many of those in a row before the operator is told. */
  suspectAfter?: number;
  onEvent?: (event: TunnelEvent) => void;
  /**
   * Open one attachment. The default dials the gateway over WSS and builds
   * a `TunnelAttachment` on it; a test replaces the whole transport here.
   */
  connect?: (target: TunnelTarget) => Promise<OpenAttachment>;
  now?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

export const DEFAULT_SETTLE_MS = 10_000;
export const DEFAULT_SUSPECT_AFTER = 5;

export class TunnelClient {
  private readonly backoff: Backoff;
  private readonly now: () => number;
  private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  private readonly connect: (target: TunnelTarget) => Promise<OpenAttachment>;
  private readonly settleMs: number;
  private readonly suspectAfter: number;

  private state: TunnelStatus = { state: "starting" };
  private attachment?: OpenAttachment;
  private loop?: Promise<void>;
  private stopping = new AbortController();
  /** Aborted to end the current wait early; replaced for each wait. */
  private waiting?: AbortController;
  private shortSessions = 0;
  /**
   * The furthest this host's credential has been seen to advance. It never
   * falls. A target read back at a lower generation is a stale read racing
   * a rotation, and dialling with it would put a replaced credential on the
   * wire; the gateway would refuse it, and the host would be down until the
   * read caught up.
   */
  private highestGeneration = Number.NEGATIVE_INFINITY;
  private readonly attachedWaiters = new Set<{
    resolve: (info: AttachedInfo) => void;
    reject: (error: Error) => void;
  }>();

  constructor(private readonly options: TunnelClientOptions) {
    this.backoff = new Backoff(options.backoff ?? DEFAULT_BACKOFF);
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? defaultSleep;
    this.connect = options.connect ?? ((target) => this.dialAndAttach(target));
    this.settleMs = options.settleMs ?? DEFAULT_SETTLE_MS;
    this.suspectAfter = options.suspectAfter ?? DEFAULT_SUSPECT_AFTER;
  }

  get status(): TunnelStatus {
    return this.state;
  }

  /** Begin attaching. Returns at once; the loop runs until `stop`. */
  start(): void {
    this.loop ??= this.run();
  }

  /**
   * Resolve when this host is attached, or reject with something an
   * operator can read.
   *
   * The daemon's readiness is this, and not a finished WebSocket handshake:
   * a host that is connected but not serving is offline to its users, and
   * reporting it ready would have `up` claim success for a host that Amika
   * answers `503 host_offline` for.
   */
  whenAttached(timeoutMs: number): Promise<AttachedInfo> {
    if (this.state.state === "attached")
      return Promise.resolve(this.state.info);
    if (this.state.state === "rejected") {
      return Promise.reject(new TunnelRejected(this.state.reason, 0));
    }
    return new Promise<AttachedInfo>((resolve, reject) => {
      const waiter = { resolve, reject };
      this.attachedWaiters.add(waiter);
      const timer = setTimeout(() => {
        this.attachedWaiters.delete(waiter);
        reject(
          new TunnelUnavailable(
            `The gateway did not attach this host within ${timeoutMs}ms. The daemon is still trying; see \`amika-hostd status\`.`,
          ),
        );
      }, timeoutMs);
      timer.unref();
      const settle = (finish: () => void) => {
        clearTimeout(timer);
        this.attachedWaiters.delete(waiter);
        finish();
      };
      waiter.resolve = (info) => settle(() => resolve(info));
      waiter.reject = (error) => settle(() => reject(error));
    });
  }

  /**
   * Drop the current attachment and dial again now.
   *
   * For a credential that was rotated or an address that moved. The
   * schedule resets: an operator action is not a failure, and making them
   * wait out a backoff they did not cause is the wrong answer.
   */
  reattach(reason: string): void {
    this.backoff.reset();
    this.shortSessions = 0;
    this.waiting?.abort();
    this.attachment?.abort(new Error(reason));
  }

  /**
   * Stop serving, release the attachment at the gateway, and return once
   * the loop has finished.
   *
   * Only this ends the tunnel. A disconnect does not: the daemon and the
   * rigs on this host keep running while it reconnects, and nothing here
   * reaches the runtime's teardown.
   */
  async stop(): Promise<void> {
    this.stopping.abort();
    this.waiting?.abort();
    const attachment = this.attachment;
    this.attachment = undefined;
    // A clean close, so the gateway gives up the route rather than waiting
    // to notice a dead socket. Aborting instead loses every request sent in
    // that window.
    if (attachment) await attachment.close().catch(() => {});
    await this.loop;
    this.setState({ state: "stopped" });
    this.emit({ type: "stopped" });
    for (const waiter of this.attachedWaiters) {
      waiter.reject(new TunnelUnavailable("The tunnel was stopped"));
    }
    this.attachedWaiters.clear();
  }

  private async run(): Promise<void> {
    while (!this.stopping.signal.aborted) {
      let reason: string;
      try {
        await this.oneSession();
        continue;
      } catch (error) {
        if (error instanceof TunnelRejected) {
          // Final. Retrying cannot change the answer, and retrying anyway
          // is how a revoked host turns into an unread log line.
          this.setState({ state: "rejected", reason: error.message });
          this.emit({ type: "rejected", reason: error.message });
          for (const waiter of this.attachedWaiters) waiter.reject(error);
          this.attachedWaiters.clear();
          return;
        }
        reason = error instanceof Error ? error.message : String(error);
      }
      if (this.stopping.signal.aborted) break;
      await this.waitBeforeRetry(reason);
    }
  }

  /** Dial, serve until the attachment ends, and report how it went. */
  private async oneSession(): Promise<void> {
    const target = await this.nextTarget();
    this.setState({ state: "dialing", attempt: this.backoff.attempts });
    this.emit({
      type: "dialing",
      url: target.gatewayUrl,
      attempt: this.backoff.attempts,
    });

    const attachment = await this.connect(target);
    // `stop` cannot cancel a handshake in flight, so an attachment can
    // arrive after the daemon decided to go. Serving on it would leave the
    // gateway holding a route for a process that has exited.
    if (this.stopping.signal.aborted) {
      await attachment.close().catch(() => {});
      return;
    }
    this.attachment = attachment;
    // Registered before the first await below. A tunnel that dies inside
    // the acknowledgement round trip would otherwise end with nobody
    // listening, and the loop would wait for an event that already fired.
    const ended = new Promise<Error | undefined>((resolve) =>
      attachment.onEnded(resolve),
    );
    const startedAt = this.now();

    let info: AttachedInfo;
    try {
      info = {
        hostId: target.hostId,
        connectionId: attachment.connectionId,
        publicUrl: attachment.publicUrl,
        rttMs: await attachment.acknowledge(),
      };
    } catch (error) {
      attachment.abort(
        error instanceof Error ? error : new Error("Attachment failed"),
      );
      this.attachment = undefined;
      this.shortSessions += 1;
      this.reportSuspicion();
      throw new TunnelUnavailable(
        `The gateway accepted the connection but did not answer the attachment ping: ${describe(error)}`,
      );
    }

    this.setState({ state: "attached", since: startedAt, info });
    this.emit({ type: "attached", info });
    for (const waiter of this.attachedWaiters) waiter.resolve(info);
    this.attachedWaiters.clear();

    const error = await ended;
    this.attachment = undefined;
    const uptimeMs = this.now() - startedAt;
    const served = attachment.servedConnections;
    const reason = error ? error.message : "the gateway closed the tunnel";
    this.emit({
      type: "detached",
      uptimeMs,
      servedConnections: served,
      reason,
    });

    // A session that connected, served nothing and died at once is what a
    // refused attachment looks like from this end, because the gateway
    // aborts the socket rather than answering an HTTP status. It is also
    // what a flapping network looks like, so this counts rather than
    // concludes.
    if (served === 0 && uptimeMs < this.settleMs) {
      this.shortSessions += 1;
      this.reportSuspicion();
    } else {
      this.shortSessions = 0;
      this.backoff.recordSession(uptimeMs);
    }
    if (this.stopping.signal.aborted) return;
    throw new TunnelUnavailable(reason);
  }

  /**
   * The target to dial, refusing one whose credential has been replaced.
   *
   * The generation only rises. A read that comes back below the highest one
   * seen is a stale cache or a file read that raced a rotation, and the
   * credential in it no longer authorizes anything. Dialling with it costs
   * a refusal from the gateway and, on a control plane that fences by
   * generation, risks nothing worse -- but the host is down for as long as
   * it keeps happening, and a retry with the same stale value is not
   * progress.
   */
  private async nextTarget(): Promise<TunnelTarget> {
    const target = await this.options.target();
    if (target.generation < this.highestGeneration) {
      throw new TunnelUnavailable(
        `Read a host credential at generation ${target.generation}, below the ${this.highestGeneration} already seen; waiting for the rotation to land.`,
      );
    }
    this.highestGeneration = target.generation;
    return target;
  }

  /** The real transport: one WSS handshake, one yamux session on it. */
  private async dialAndAttach(target: TunnelTarget): Promise<OpenAttachment> {
    const dialed = await dialTunnel(target, {
      limits: this.options.limits,
      handshakeTimeoutMs: this.options.handshakeTimeoutMs,
      userAgent: this.options.userAgent,
    });
    const attachment = new TunnelAttachment(dialed.ws, {
      limits: this.options.limits,
      keepAliveIntervalMs: this.options.keepAliveIntervalMs,
      pingTimeoutMs: this.options.pingTimeoutMs,
      drainMs: this.options.drainMs,
      onConnection: this.options.onConnection,
    });
    return Object.assign(attachment, {
      connectionId: dialed.connectionId,
      publicUrl: dialed.publicUrl,
    });
  }

  private reportSuspicion(): void {
    if (this.shortSessions !== this.suspectAfter) return;
    this.emit({
      type: "suspect-credential",
      consecutiveShortSessions: this.shortSessions,
    });
  }

  private async waitBeforeRetry(reason: string): Promise<void> {
    const delayMs = this.backoff.nextDelayMs();
    const attempt = this.backoff.attempts;
    this.setState({ state: "waiting", attempt, delayMs, reason });
    this.emit({ type: "waiting", attempt, delayMs, reason });
    const waiting = new AbortController();
    this.waiting = waiting;
    const stop = () => waiting.abort();
    this.stopping.signal.addEventListener("abort", stop, { once: true });
    try {
      await this.sleep(delayMs, waiting.signal);
    } catch {
      // An aborted wait is a shutdown or a `reattach`, not a failure.
    } finally {
      this.stopping.signal.removeEventListener("abort", stop);
      this.waiting = undefined;
    }
  }

  private setState(state: TunnelStatus): void {
    this.state = state;
  }

  /**
   * Report an event, and let nothing a listener does reach this loop. A
   * listener that throws would otherwise stop the daemon reconnecting, and
   * the only place to report that failure is the listener that just failed.
   */
  private emit(event: TunnelEvent): void {
    if (!this.options.onEvent) return;
    try {
      this.options.onEvent(event);
    } catch {
      // Deliberate: see above.
    }
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("aborted"));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    timer.unref();
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

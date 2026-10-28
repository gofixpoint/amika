/**
 * What the daemon does about a tunnel that ended.
 *
 * The transport is replaced here on purpose. Every branch below is a policy
 * decision -- retry, wait longer, stop and tell the operator -- and running
 * them over a real socket would test the socket instead.
 * `tunnel-session.test.ts` covers the transport against a real peer.
 */
import { describe, expect, it, vi } from "vitest";
import {
  TunnelClient,
  type OpenAttachment,
  type TunnelClientOptions,
  type TunnelEvent,
} from "./tunnel-client.js";
import { TunnelRejected, TunnelUnavailable } from "./tunnel-dial.js";

/** One attachment a test drives by hand. */
class FakeAttachment implements OpenAttachment {
  servedConnections = 0;
  closed = false;
  aborted?: Error;
  private listeners: Array<(error?: Error) => void> = [];
  private ended = false;

  constructor(
    readonly connectionId?: string,
    readonly publicUrl?: string,
    private readonly ack: () => Promise<number> = async () => 1,
  ) {}

  acknowledge(): Promise<number> {
    return this.ack();
  }

  onEnded(listener: (error?: Error) => void): void {
    if (this.ended) listener(undefined);
    else this.listeners.push(listener);
  }

  async close(): Promise<void> {
    this.closed = true;
    this.end();
  }

  abort(error: Error): void {
    this.aborted = error;
    this.end(error);
  }

  /** The gateway went away, or the keep-alive noticed it had. */
  end(error?: Error): void {
    if (this.ended) return;
    this.ended = true;
    for (const listener of this.listeners.splice(0)) listener(error);
  }
}

interface Harness {
  client: TunnelClient;
  events: TunnelEvent[];
  waits: number[];
  opened: FakeAttachment[];
  /** How many times the client has asked for an attachment. */
  connects: () => number;
  /** Move the simulated clock on, for a session that lasted. */
  advance: (ms: number) => void;
}

/**
 * A client whose transport is a queue of outcomes: an attachment to serve,
 * or an error to fail the dial with. Time is simulated, so a test that
 * exercises a sixty-second backoff takes no longer than one that does not.
 */
function harness(
  outcomes: Array<FakeAttachment | Error | (() => FakeAttachment | Error)>,
  overrides: Partial<TunnelClientOptions> = {},
): Harness {
  const events: TunnelEvent[] = [];
  const waits: number[] = [];
  const opened: FakeAttachment[] = [];
  let connects = 0;
  let clock = 0;
  const client = new TunnelClient({
    target: () => ({
      gatewayUrl: "wss://gateway.example/attach",
      hostId: "host-1",
      credential: "cred-1",
      generation: 1,
    }),
    onConnection: () => {},
    keepAliveIntervalMs: 1_000,
    pingTimeoutMs: 100,
    drainMs: 100,
    handshakeTimeoutMs: 1_000,
    userAgent: "amika-hostd/test",
    settleMs: 10_000,
    suspectAfter: 3,
    backoff: {
      minDelayMs: 500,
      initialDelayMs: 1_000,
      maxDelayMs: 8_000,
      multiplier: 2,
      resetAfterMs: 60_000,
      random: () => 1,
    },
    onEvent: (event) => events.push(event),
    now: () => clock,
    sleep: async (ms, signal) => {
      waits.push(ms);
      clock += ms;
      // One real turn of the loop, so a test that lets the client run out
      // of outcomes yields instead of blocking the event loop.
      await new Promise((done) => setTimeout(done, 0));
      if (signal.aborted) throw new Error("aborted");
    },
    connect: async () => {
      connects += 1;
      const next = outcomes.shift();
      if (next === undefined) throw new Error("the test ran out of outcomes");
      const outcome = typeof next === "function" ? next() : next;
      if (outcome instanceof Error) throw outcome;
      const attachment = outcome as FakeAttachment;
      opened.push(attachment);
      return attachment;
    },
    ...overrides,
  });
  return {
    client,
    events,
    waits,
    opened,
    connects: () => connects,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

/**
 * Let the client's loop run until it is waiting on something. Several turns,
 * because one retry costs a dial, a wait and an acknowledgement, and a test
 * that drives three retries would otherwise assert halfway through.
 */
async function settle(turns = 25): Promise<void> {
  for (let turn = 0; turn < turns; turn += 1) {
    await new Promise((done) => setTimeout(done, 0));
  }
}

describe("a tunnel that drops", () => {
  it("is dialled again", async () => {
    const first = new FakeAttachment("conn-1");
    const second = new FakeAttachment("conn-2");
    const { client, events } = harness([first, second]);
    client.start();
    await settle();

    first.end(new Error("gateway restarted"));
    await settle();

    expect(client.status).toMatchObject({
      state: "attached",
      info: { connectionId: "conn-2" },
    });
    // The host keeps its identity across the reconnect and takes a new
    // connection id, which is what the gateway's fencing needs.
    expect(
      events
        .filter((event) => event.type === "attached")
        .map((event) => event.info.connectionId),
    ).toEqual(["conn-1", "conn-2"]);
    await client.stop();
  });

  it("waits longer each time the gateway stays down", async () => {
    const { client, waits } = harness([
      new Error("ECONNREFUSED"),
      new Error("ECONNREFUSED"),
      new Error("ECONNREFUSED"),
      new FakeAttachment("conn-1"),
    ]);
    client.start();
    await settle();

    expect(waits).toEqual([1_000, 2_000, 4_000]);
    expect(client.status.state).toBe("attached");
    await client.stop();
  });

  it("starts the schedule again after a session that worked", async () => {
    const first = new FakeAttachment("conn-1");
    const { client, waits, advance } = harness([
      new Error("ECONNREFUSED"),
      new Error("ECONNREFUSED"),
      first,
      new Error("ECONNREFUSED"),
      new FakeAttachment("conn-2"),
    ]);
    client.start();
    await settle();
    // The simulated clock advanced by the two waits; serve for long enough
    // that the session counts as having worked.
    first.servedConnections = 7;
    advance(120_000);
    first.end(new Error("network changed"));
    await settle();

    // Without the reset the third wait would be 4s and the fourth 8s: the
    // schedule would carry the morning's outage into the evening's.
    expect(waits).toEqual([1_000, 2_000, 1_000, 2_000]);
    await client.stop();
  });
});

describe("a gateway that refuses this host", () => {
  it("stops the loop instead of retrying for ever", async () => {
    const { client, events, waits, connects } = harness([
      new TunnelRejected("credential revoked", 403),
      new FakeAttachment("never reached"),
    ]);
    client.start();
    await settle();

    expect(client.status).toEqual({
      state: "rejected",
      reason: "credential revoked",
    });
    expect(connects()).toBe(1);
    expect(waits).toEqual([]);
    expect(events.at(-1)).toEqual({
      type: "rejected",
      reason: "credential revoked",
    });
    await client.stop();
  });

  it("dials again when reattached, as a restored credential can change the answer", async () => {
    // A rejection ends the loop. Without a restart here, rotating the
    // credential and reattaching would leave the host rejected until the
    // process restarted.
    const { client, connects } = harness([
      new TunnelRejected("credential revoked", 403),
      new FakeAttachment("conn-2"),
    ]);
    client.start();
    await settle();
    expect(client.status).toMatchObject({ state: "rejected" });

    client.reattach("credential restored");
    await settle();

    expect(connects()).toBe(2);
    expect(client.status).toMatchObject({ state: "attached" });
    await client.stop();
  });

  it("waits for the new attempt, not the old refusal, right after reattaching", async () => {
    // A caller that reattaches and at once waits for readiness must not be
    // handed the rejection the restart is meant to replace.
    const { client } = harness([
      new TunnelRejected("credential revoked", 403),
      new FakeAttachment("conn-2"),
    ]);
    client.start();
    await settle();

    client.reattach("credential restored");
    const ready = client.whenAttached(5_000);

    await expect(ready).resolves.toMatchObject({ connectionId: "conn-2" });
    await client.stop();
  });

  it("does not come back to life when reattached after stopping", async () => {
    const { client, connects } = harness([
      new TunnelRejected("credential revoked", 403),
      new FakeAttachment("never reached"),
    ]);
    client.start();
    await settle();
    await client.stop();

    client.reattach("too late");
    await settle();

    expect(connects()).toBe(1);
    expect(client.status).toEqual({ state: "stopped" });
  });

  it("fails the daemon's readiness with the operator's next step", async () => {
    const { client } = harness([
      new TunnelRejected("Run `amika-hostd setup` to enrol this host", 401),
    ]);
    const ready = client.whenAttached(5_000);
    client.start();

    await expect(ready).rejects.toThrow(/amika-hostd setup/);
    await client.stop();
  });

  it("keeps retrying an outage, which is a different answer", async () => {
    const { client, waits } = harness([
      new TunnelUnavailable("Gateway answered 503", 503),
      new FakeAttachment("conn-1"),
    ]);
    client.start();
    await settle();

    expect(client.status.state).toBe("attached");
    expect(waits).toEqual([1_000]);
    await client.stop();
  });
});

describe("a session that connects and dies at once", () => {
  it("is counted, and named as a likely credential problem", async () => {
    // The gateway accepts the WebSocket before it authorizes, and reports
    // a refusal by aborting the socket. From here that is indistinguishable
    // from a flapping network, so the daemon counts rather than concludes.
    const attachments = [0, 1, 2, 3].map(
      (index) => new FakeAttachment(`conn-${index}`),
    );
    const { client, events } = harness([...attachments]);
    client.start();
    for (const attachment of attachments) {
      await settle();
      attachment.end();
    }
    await settle();

    expect(events).toContainEqual({
      type: "suspect-credential",
      consecutiveShortSessions: 3,
    });
    await client.stop();
  });

  it("is not counted once the session served something", async () => {
    const attachments = [0, 1, 2, 3].map(
      (index) => new FakeAttachment(`conn-${index}`),
    );
    const { client, events } = harness([...attachments]);
    client.start();
    for (const attachment of attachments) {
      await settle();
      attachment.servedConnections = 1;
      attachment.end();
    }
    await settle();

    expect(events.some((event) => event.type === "suspect-credential")).toBe(
      false,
    );
    await client.stop();
  });
});

describe("a credential that has been rotated", () => {
  it("is never replaced by a stale read of the one before it", async () => {
    // A rotation advances the generation. A read that comes back below the
    // highest one seen raced the rotation, and dialling with it would put
    // a replaced credential on the wire.
    let generation = 2;
    const { client, connects } = harness([new FakeAttachment("conn-1")], {
      target: () => ({
        gatewayUrl: "wss://gateway.example/attach",
        hostId: "host-1",
        credential: `cred-${generation}`,
        generation,
      }),
    });
    client.start();
    await settle();
    expect(connects()).toBe(1);

    generation = 1;
    client.reattach("credential rotated");
    await settle();

    expect(client.status).toMatchObject({ state: "waiting" });
    expect(client.status).toMatchObject({
      reason: expect.stringContaining("below the 2 already seen"),
    });
    await client.stop();
  });

  it("drops the live attachment when an operator rotates it", async () => {
    const first = new FakeAttachment("conn-1");
    const { client, opened } = harness([first, new FakeAttachment("conn-2")]);
    client.start();
    await settle();

    client.reattach("credential rotated");
    await settle();

    expect(first.aborted?.message).toBe("credential rotated");
    expect(opened.at(-1)?.connectionId).toBe("conn-2");
    await client.stop();
  });
});

describe("waiting between attempts", () => {
  it("keeps the process alive while it waits to retry", async () => {
    // Between attempts the retry timer can be all that is left of a plain
    // `serve`. An unreferenced one lets Node exit instead of reconnecting.
    const timers: NodeJS.Timeout[] = [];
    const realSetTimeout = globalThis.setTimeout;
    const spy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((
      fn: () => void,
      ms?: number,
    ) => {
      const timer = realSetTimeout(fn, ms);
      timers.push(timer);
      return timer;
    }) as typeof setTimeout);
    try {
      const { client } = harness([new Error("connection refused")], {
        // The real sleep, not the harness's simulated one.
        sleep: undefined,
      });
      client.start();
      await new Promise((done) => realSetTimeout(done, 20));

      const retry = timers.find(
        (timer) =>
          (timer as unknown as { _idleTimeout: number })._idleTimeout >= 500,
      );
      expect(retry?.hasRef()).toBe(true);
      await client.stop();
    } finally {
      spy.mockRestore();
    }
  });
});

describe("shutting down", () => {
  it("closes the attachment rather than dropping it", async () => {
    // A clean close is what makes the gateway give up the route. Dropping
    // the socket leaves it answering requests into a daemon that has gone.
    const attachment = new FakeAttachment("conn-1");
    const { client } = harness([attachment]);
    client.start();
    await settle();

    await client.stop();

    expect(attachment.closed).toBe(true);
    expect(attachment.aborted).toBeUndefined();
    expect(client.status).toEqual({ state: "stopped" });
  });

  it("does not dial again afterwards", async () => {
    const attachment = new FakeAttachment("conn-1");
    const { client } = harness([attachment, new FakeAttachment("conn-2")]);
    client.start();
    await settle();

    await client.stop();
    await settle();

    expect(client.status).toEqual({ state: "stopped" });
  });

  it("ends a backoff wait instead of sitting it out", async () => {
    const { client } = harness([new Error("ECONNREFUSED")], {
      sleep: (_ms, signal) =>
        new Promise((resolve, reject) => {
          if (signal.aborted) reject(new Error("aborted"));
          signal.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          });
        }),
    });
    client.start();
    await settle();

    await expect(
      Promise.race([
        client.stop(),
        new Promise((_, fail) =>
          setTimeout(() => fail(new Error("hung")), 500),
        ),
      ]),
    ).resolves.toBeUndefined();
  });
});

describe("readiness", () => {
  it("waits for an attachment, not for a handshake", async () => {
    let acknowledge: (rtt: number) => void = () => {};
    const attachment = new FakeAttachment(
      "conn-1",
      "https://h-1.hosts.amika.dev",
      () => new Promise<number>((resolve) => (acknowledge = resolve)),
    );
    const { client } = harness([attachment]);
    const ready = client.whenAttached(5_000);
    client.start();
    await settle();

    const notYet = vi.fn();
    void ready.then(notYet);
    await settle();
    expect(notYet).not.toHaveBeenCalled();

    acknowledge(12);

    await expect(ready).resolves.toEqual({
      hostId: "host-1",
      connectionId: "conn-1",
      publicUrl: "https://h-1.hosts.amika.dev",
      rttMs: 12,
    });
    await client.stop();
  });

  it("gives up after its own bound while the daemon keeps trying", async () => {
    const { client } = harness([new Error("ECONNREFUSED")]);
    client.start();

    await expect(client.whenAttached(10)).rejects.toThrow(/did not attach/);
    await client.stop();
  });
});

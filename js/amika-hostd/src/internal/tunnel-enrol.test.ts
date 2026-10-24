import { describe, expect, it } from "vitest";
import { enrolForTunnel } from "./tunnel-enrol.js";
import type { HostEnrolment } from "./amika-api.js";
import type { TunnelEnrolment } from "./tunnel-target.js";

const API = { apiUrl: "https://app.amika.test", apiKey: "k" };
const HOST = { id: "host_1" };

const ANSWER: HostEnrolment = {
  credential: "amkht_b3JnXzE.s3cret",
  generation: 3,
  gateway_url: "wss://gateway.amika.run/v1/host-tunnel",
  transport_mode: "tunnel",
};

function store() {
  let held: string | undefined;
  return {
    attachmentCredential: {
      description: "the test store",
      get: () => held,
      set: (value: string) => {
        held = value;
      },
    },
  };
}

describe("enrolForTunnel", () => {
  it("records what the control plane answered", async () => {
    const secrets = store();
    const written: Array<[string, TunnelEnrolment]> = [];

    const enrolment = await enrolForTunnel(
      API,
      HOST,
      secrets,
      "/state/tunnel-enrolment.json",
      {
        enrol: async () => ANSWER,
        write: (file, record) => written.push([file, record]),
      },
    );

    expect(secrets.attachmentCredential.get()).toBe(ANSWER.credential);
    expect(written).toEqual([
      [
        "/state/tunnel-enrolment.json",
        {
          hostId: "host_1",
          generation: 3,
          gatewayUrl: "wss://gateway.amika.run/v1/host-tunnel",
        },
      ],
    ]);
    expect(enrolment.gatewayUrl).toBe(ANSWER.gateway_url);
  });

  it("keeps the credential out of the record", async () => {
    // The record is read and written in the ordinary course of running
    // the daemon. One that held the credential would put it wherever the
    // file was copied -- a backup, a support bundle, an `scp` of the
    // state directory.
    const written: TunnelEnrolment[] = [];

    await enrolForTunnel(API, HOST, store(), "/state/f.json", {
      enrol: async () => ANSWER,
      write: (_file, record) => written.push(record),
    });

    expect(JSON.stringify(written[0])).not.toContain("s3cret");
  });

  it("stores the credential before the record", async () => {
    // Either order is recoverable, but this one fails the better way. A
    // credential with no record reads as "not enrolled", which is true.
    // A record with no credential reads as an enrolled host whose secret
    // has gone missing, which is alarming and wrong.
    const order: string[] = [];
    const secrets = {
      attachmentCredential: {
        description: "the test store",
        get: () => undefined,
        set: () => order.push("credential"),
      },
    };

    await enrolForTunnel(API, HOST, secrets, "/state/f.json", {
      enrol: async () => ANSWER,
      write: () => order.push("record"),
    });

    expect(order).toEqual(["credential", "record"]);
  });

  it("writes nothing when the control plane refuses", async () => {
    // A half-enrolled host is worse than an unenrolled one: it reports a
    // gateway it has no credential for, and the daemon's advice would be
    // to enrol again when enrolling never succeeded.
    const secrets = store();
    const written: TunnelEnrolment[] = [];

    await expect(
      enrolForTunnel(API, HOST, secrets, "/state/f.json", {
        enrol: async () => {
          throw new Error("403");
        },
        write: (_file, record) => written.push(record),
      }),
    ).rejects.toThrow("403");

    expect(secrets.attachmentCredential.get()).toBeUndefined();
    expect(written).toEqual([]);
  });

  it("passes the caller's cancellation through", async () => {
    // Setup runs under Ctrl-C handling, and an enrolment that ignored it
    // would hold the prompt open for the request timeout.
    const seen: Array<AbortSignal | undefined> = [];
    const cancel = new AbortController().signal;

    await enrolForTunnel(
      API,
      HOST,
      store(),
      "/state/f.json",
      {
        enrol: async (_api, _host, _fetcher, signal) => {
          seen.push(signal);
          return ANSWER;
        },
        write: () => {},
      },
      cancel,
    );

    expect(seen).toEqual([cancel]);
  });

  it("uses the host id the caller enrolled, not one from the answer", async () => {
    // The answer carries no host id, and inventing one here would let the
    // record name a host the daemon never registered.
    const written: TunnelEnrolment[] = [];

    await enrolForTunnel(API, { id: "host_other" }, store(), "/state/f.json", {
      enrol: async () => ANSWER,
      write: (_file, record) => written.push(record),
    });

    expect(written[0]!.hostId).toBe("host_other");
  });
});

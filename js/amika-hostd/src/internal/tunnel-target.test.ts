import { describe, expect, it, vi } from "vitest";
import { ConfigError } from "./config.js";
import type { Secret } from "./credentials.js";
import {
  readTunnelEnrolment,
  resolveTunnelTarget,
  tunnelEnrolmentPath,
  writeTunnelEnrolment,
  type TunnelEnrolment,
} from "./tunnel-target.js";

const ENROLLED: TunnelEnrolment = {
  hostId: "host-abc",
  generation: 3,
  gatewayUrl: "wss://tunnel.amika.dev/attach",
  publicUrl: "https://h-abc.hosts.amika.dev",
};

function credential(value: string | undefined): Secret {
  return {
    description: "the test keychain",
    get: () => value,
    set: () => {},
  };
}

describe("the record on disk", () => {
  it("round-trips through the file the daemon reads", () => {
    let written = "";
    writeTunnelEnrolment("/state/x.json", ENROLLED, (_file, contents) => {
      written = contents;
    });

    expect(readTunnelEnrolment("/state/x.json", () => written)).toEqual(
      ENROLLED,
    );
  });

  it("holds no credential, so a copy of it is worth nothing", () => {
    let written = "";
    writeTunnelEnrolment("/state/x.json", ENROLLED, (_file, contents) => {
      written = contents;
    });

    expect(written).not.toContain("credential");
  });

  it("is absent, not invalid, on a host that was never enrolled", () => {
    const missing = () => {
      throw Object.assign(new Error("no such file"), { code: "ENOENT" });
    };

    expect(readTunnelEnrolment("/state/x.json", missing)).toBeUndefined();
  });

  it("refuses a record it cannot read rather than reporting none", () => {
    // Reporting none would send the operator to `setup`, and enrolling
    // again mints a second credential that outlives the first.
    expect(() => readTunnelEnrolment("/state/x.json", () => "{")).toThrow(
      /not valid JSON/,
    );
    expect(() =>
      readTunnelEnrolment("/state/x.json", () => '{"host_id":"a"}'),
    ).toThrow(/invalid fields: generation, gateway_url/);
  });

  it("names the field and never the value", () => {
    const secretish = JSON.stringify({
      host_id: "host-abc",
      generation: 3,
      gateway_url: 42,
    });

    expect(() => readTunnelEnrolment("/x.json", () => secretish)).toThrow(
      /invalid fields: gateway_url$/,
    );
  });

  it("lives beside the daemon's other state", () => {
    expect(tunnelEnrolmentPath("/state/amika-hostd")).toBe(
      "/state/amika-hostd/tunnel-enrolment.json",
    );
  });
});

describe("the target one dial needs", () => {
  it("uses the gateway the control plane assigned", () => {
    expect(
      resolveTunnelTarget(
        {},
        { attachmentCredential: credential("c") },
        ENROLLED,
      ),
    ).toEqual({
      gatewayUrl: "wss://tunnel.amika.dev/attach",
      hostId: "host-abc",
      credential: "c",
      generation: 3,
    });
  });

  it("lets an operator override it, for a gateway of their own", () => {
    const target = resolveTunnelTarget(
      { tunnelGatewayUrl: "ws://127.0.0.1:8787/attach" },
      { attachmentCredential: credential("c") },
      ENROLLED,
    );

    expect(target.gatewayUrl).toBe("ws://127.0.0.1:8787/attach");
  });

  it("reads the credential again on every call", () => {
    // A rotation while the daemon runs has to reach the next dial without
    // a restart.
    const get = vi.fn(() => "c");
    const secrets = {
      attachmentCredential: { description: "d", get, set: () => {} },
    };

    resolveTunnelTarget({}, secrets, ENROLLED);
    resolveTunnelTarget({}, secrets, ENROLLED);

    expect(get).toHaveBeenCalledTimes(2);
  });

  it("says what to run when the host was never enrolled", () => {
    expect(() =>
      resolveTunnelTarget(
        {},
        { attachmentCredential: credential("c") },
        undefined,
      ),
    ).toThrow(ConfigError);
    expect(() =>
      resolveTunnelTarget(
        {},
        { attachmentCredential: credential("c") },
        undefined,
      ),
    ).toThrow(/amika-hostd setup/);
  });

  it("says where the credential should have been when it is missing", () => {
    expect(() =>
      resolveTunnelTarget(
        {},
        { attachmentCredential: credential(undefined) },
        ENROLLED,
      ),
    ).toThrow(/the test keychain/);
  });

  it("treats a blank credential as missing", () => {
    expect(() =>
      resolveTunnelTarget(
        {},
        { attachmentCredential: credential("   ") },
        ENROLLED,
      ),
    ).toThrow(/No tunnel attachment credential/);
  });
});

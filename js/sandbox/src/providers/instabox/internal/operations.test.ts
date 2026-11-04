import { describe, expect, it } from "vitest";
import { SANDBOX_STATUS_VALUES } from "../../../sandbox-status";
import { instaboxName } from "./names";
import {
  autoSuspendSeconds,
  envProfileScript,
  mapInstaboxSandboxState,
} from "./operations";
import { instaboxSshDestination } from "./ssh";
import { mapInstaboxSnapshotStatus } from "./snapshot-operations";

const VALID = /^[a-z0-9][a-z0-9-]{0,62}$/;

describe("instaboxName", () => {
  it("keeps a name Instabox already accepts", () => {
    expect(instaboxName("dev")).toBe("dev");
    expect(instaboxName("rig--0b6e2a9c-1d2e")).toBe("rig--0b6e2a9c-1d2e");
  });

  it("turns any other name into a valid, distinct one", () => {
    const names = [
      "contract-sb-20261104T230000Z-1a2b-1",
      "org_abc/sandbox/custom-snapshot",
      "Org_ABC/sandbox/custom-snapshot",
      "-leading",
      "!!!",
      "x".repeat(200),
    ];
    const mapped = names.map(instaboxName);
    for (const name of mapped) expect(name).toMatch(VALID);
    expect(new Set(mapped).size).toBe(names.length);
    expect(mapped[0]).toMatch(
      /^contract-sb-20261104t230000z-1a2b-1-[0-9a-f]{10}$/,
    );
    expect(mapped[4]).toMatch(/^amika-[0-9a-f]{10}$/);
  });

  it("maps a name the same way every time", () => {
    expect(instaboxName("A/b")).toBe(instaboxName("A/b"));
  });
});

describe("mapInstaboxSandboxState", () => {
  it("maps every Instabox machine state", () => {
    const cases: Record<string, string> = {
      creating: "creating",
      starting: "starting",
      resuming: "starting",
      running: "running",
      stopping: "stopping",
      stopped: "stopped",
      suspending: "suspending",
      suspended: "suspended",
      error: "failed",
      deleting: "unknown",
      unknown: "unknown",
    };
    for (const [raw, status] of Object.entries(cases)) {
      expect(mapInstaboxSandboxState(raw), raw).toBe(status);
      expect(SANDBOX_STATUS_VALUES).toContain(status);
    }
  });
});

describe("autoSuspendSeconds", () => {
  it("clamps to the 5-30 minute range Instabox takes", () => {
    expect(autoSuspendSeconds(undefined)).toBeUndefined();
    expect(autoSuspendSeconds(null)).toBeUndefined();
    expect(autoSuspendSeconds(0)).toBe(0);
    expect(autoSuspendSeconds(-1)).toBe(0);
    expect(autoSuspendSeconds(1)).toBe(300);
    expect(autoSuspendSeconds(15)).toBe(900);
    expect(autoSuspendSeconds(120)).toBe(1800);
  });
});

describe("envProfileScript", () => {
  it("exports each variable with shell quoting", () => {
    expect(envProfileScript({ A: "it's", B: "$HOME" })).toBe(
      "# Written by Amika at create.\n" +
        "export A='it'\"'\"'s'\n" +
        "export B='$HOME'\n",
    );
  });

  it("refuses a bad variable name", () => {
    expect(() => envProfileScript({ "A B": "x" })).toThrow(/Invalid/);
  });
});

describe("instaboxSshDestination", () => {
  it("carries a non-default port in an ssh:// URI", () => {
    expect(instaboxSshDestination("ibssh_x", "ssh.instabox.sh", 2222)).toBe(
      "ssh://ibssh_x@ssh.instabox.sh:2222",
    );
    expect(instaboxSshDestination("ibssh_x", "ssh.instabox.sh", 22)).toBe(
      "ibssh_x@ssh.instabox.sh",
    );
  });
});

describe("mapInstaboxSnapshotStatus", () => {
  it("maps ready, pending, and failed", () => {
    expect(mapInstaboxSnapshotStatus("ready")).toBe("active");
    expect(mapInstaboxSnapshotStatus("pending")).toBe("building");
    expect(mapInstaboxSnapshotStatus("failed")).toBe("build_failed");
  });
});

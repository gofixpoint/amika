import { beforeEach, describe, it, expect, vi } from "vitest";
import { SANDBOX_ORG_ID_LABEL } from "../../../constants";
import type { DaytonaConfig } from "../config";
import {
  _parseSshDestination,
  listDaytonaSandboxes,
  mapDaytonaSandboxState,
  streamDaytonaCommandLogs,
} from "./operations";

const daytonaList = vi.fn();
const daytonaGet = vi.fn();
vi.mock("./client", () => ({
  getDaytonaClient: () => ({
    list: (...args: unknown[]) => daytonaList(...args),
    get: (...args: unknown[]) => daytonaGet(...args),
  }),
}));

async function* asyncOf<T>(items: T[]): AsyncGenerator<T> {
  for (const item of items) yield item;
}

describe("_parseSshDestination", () => {
  it("strips the leading ssh prefix from a Daytona command", () => {
    expect(_parseSshDestination("ssh user-token@ssh.app.daytona.io")).toBe(
      "user-token@ssh.app.daytona.io",
    );
  });

  it("collapses extra whitespace after the ssh keyword", () => {
    expect(_parseSshDestination("ssh   user@host")).toBe("user@host");
  });

  it("leaves an already-bare destination unchanged", () => {
    expect(_parseSshDestination("user@host")).toBe("user@host");
  });

  it("trims trailing whitespace after the destination", () => {
    expect(_parseSshDestination("ssh user@host  ")).toBe("user@host");
  });
});

describe("mapDaytonaSandboxState", () => {
  it("maps every raw Daytona state onto the canonical vocabulary", () => {
    const cases: Record<string, string> = {
      creating: "creating",
      pending_build: "creating",
      building_snapshot: "creating",
      pulling_snapshot: "creating",
      restoring: "starting",
      starting: "starting",
      resuming: "starting",
      resizing: "starting",
      started: "running",
      forking: "running",
      snapshotting: "snapshotting",
      stopping: "stopping",
      pausing: "stopping",
      stopped: "suspended",
      paused: "suspended",
      archiving: "suspended",
      archived: "suspended",
      error: "failed",
      build_failed: "failed",
      destroying: "failed",
      destroyed: "failed",
    };
    for (const [raw, expected] of Object.entries(cases)) {
      expect(mapDaytonaSandboxState(raw), raw).toBe(expected);
    }
  });

  it("maps unrecognized values to unknown", () => {
    expect(mapDaytonaSandboxState("unknown")).toBe("unknown");
    expect(mapDaytonaSandboxState("11184809")).toBe("unknown");
    expect(mapDaytonaSandboxState("")).toBe("unknown");
  });
});

describe("listDaytonaSandboxes", () => {
  const config: DaytonaConfig = {
    apiKey: "key",
    apiUrl: "https://app.daytona.io/api",
    organizationId: "org_default",
  };

  beforeEach(() => daytonaList.mockReset());

  it("maps each sandbox to its org (from labels), state, and native GiB sizing", async () => {
    daytonaList.mockReturnValue(
      asyncOf([
        {
          id: "sb_1",
          labels: { [SANDBOX_ORG_ID_LABEL]: "org_abc" },
          cpu: 4,
          memory: 8,
          disk: 20,
          state: "started",
        },
      ]),
    );

    const listings = await listDaytonaSandboxes(config);

    // Daytona reports cpu/memory/disk already in billing units (vCPUs/GiB/GiB).
    expect(listings).toEqual([
      {
        providerSandboxId: "sb_1",
        orgId: "org_abc",
        state: "started",
        sizing: { vcpus: 4, memoryGib: 8, diskGib: 20 },
      },
    ]);
  });

  it("reports a null org and 'unknown' state when the stamp/state are absent", async () => {
    daytonaList.mockReturnValue(
      asyncOf([{ id: "sb_1", labels: {}, cpu: 1, memory: 2, disk: 10 }]),
    );

    const [listing] = await listDaytonaSandboxes(config);
    expect(listing?.orgId).toBeNull();
    expect(listing?.state).toBe("unknown");
  });

  it("walks every page the cursor iterator yields", async () => {
    daytonaList.mockReturnValue(
      asyncOf([
        {
          id: "sb_1",
          labels: {},
          cpu: 1,
          memory: 2,
          disk: 10,
          state: "started",
        },
        {
          id: "sb_2",
          labels: {},
          cpu: 2,
          memory: 4,
          disk: 10,
          state: "stopped",
        },
      ]),
    );

    const ids = (await listDaytonaSandboxes(config)).map(
      (l) => l.providerSandboxId,
    );
    expect(ids).toEqual(["sb_1", "sb_2"]);
  });
});

describe("streamDaytonaCommandLogs", () => {
  it("gives every stream its own session, even within one millisecond", () => {
    // Session ids are per-sandbox and the stream deletes its session when it
    // ends, so two concurrent streams sharing an id would mean the first to
    // finish reaps the other's still-running command. A timestamp-derived id
    // collides at exactly the concurrency this has to survive.
    const created: string[] = [];
    daytonaGet.mockResolvedValue({
      process: {
        createSession: (id: string) => {
          created.push(id);
          return Promise.resolve();
        },
        executeSessionCommand: () => Promise.resolve({ cmdId: "cmd-1" }),
        getSessionCommandLogs: () => Promise.resolve(),
        deleteSession: () => Promise.resolve(),
      },
    });

    const config = {} as DaytonaConfig;
    const handlers = { onStdout: () => {}, onStderr: () => {} };
    // Started in the same tick, so any clock-derived id would be identical.
    return Promise.all([
      streamDaytonaCommandLogs(config, "sbx-1", "echo a", handlers),
      streamDaytonaCommandLogs(config, "sbx-1", "echo b", handlers),
    ]).then(() => {
      expect(created).toHaveLength(2);
      expect(created[0]).not.toBe(created[1]);
      expect(created[0]!.startsWith("stream-")).toBe(true);
    });
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { DaytonaConfig } from "../config";

// Mock the generated api-client: keep the real enums (SandboxState/SandboxClass)
// but stub `SandboxApi` so we drive stop/start/snapshot/get from the test.
const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    createSandbox: vi.fn(),
    deleteSandbox: vi.fn(),
    stopSandbox: vi.fn(),
    startSandbox: vi.fn(),
    createSandboxSnapshot: vi.fn(),
    getSandbox: vi.fn(),
  },
}));

vi.mock("@daytona/api-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@daytona/api-client")>();
  return {
    ...actual,
    Configuration: vi.fn(),
    // Regular function (not an arrow) so it works as a constructor with `new`.
    SandboxApi: vi.fn(function () {
      return apiMock;
    }),
  };
});

import { captureVmSandboxSnapshot, createVmSandbox } from "./vm";

const config: DaytonaConfig = {
  apiKey: "key",
  apiUrl: "https://daytona.example",
  target: "experimental",
  organizationId: undefined,
  useVm: true,
};

/** Queue the getSandbox states the poll loop will read, in order. */
function queueStates(...states: string[]): void {
  apiMock.getSandbox.mockReset();
  for (const state of states) {
    apiMock.getSandbox.mockResolvedValueOnce({ data: { state } });
  }
}

describe("captureVmSandboxSnapshot", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    apiMock.stopSandbox.mockReset().mockResolvedValue({ data: {} });
    apiMock.startSandbox.mockReset().mockResolvedValue({ data: {} });
    apiMock.createSandboxSnapshot.mockReset().mockResolvedValue({ data: {} });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("stops the VM, snapshots it cold (no includeMemory), then restarts when keeping the source", async () => {
    // stop → STOPPED; snapshot → SNAPSHOTTING then STOPPED; restart → STARTED.
    queueStates("stopped", "snapshotting", "stopped", "started");

    const promise = captureVmSandboxSnapshot(
      config,
      "sbx-1",
      "org/sandbox/snap",
      900,
      true,
    );
    // One poll gap while the snapshot runs (SNAPSHOTTING → STOPPED).
    await vi.advanceTimersByTimeAsync(1_000);
    await promise;

    expect(apiMock.stopSandbox).toHaveBeenCalledTimes(1);
    // Snapshot body must NOT include memory — that is the whole point of the fix.
    expect(apiMock.createSandboxSnapshot).toHaveBeenCalledWith(
      "sbx-1",
      { name: "org/sandbox/snap" },
      undefined,
      expect.objectContaining({ timeout: expect.any(Number) }),
    );
    expect(apiMock.createSandboxSnapshot.mock.calls[0][1]).not.toHaveProperty(
      "includeMemory",
    );
    // Keep path restarts the source.
    expect(apiMock.startSandbox).toHaveBeenCalledTimes(1);
  });

  it("does not restart the source when restartAfterCapture is false", async () => {
    queueStates("stopped", "snapshotting", "stopped");

    const promise = captureVmSandboxSnapshot(
      config,
      "sbx-1",
      "org/sandbox/snap",
      900,
      false,
    );
    await vi.advanceTimersByTimeAsync(1_000);
    await promise;

    expect(apiMock.stopSandbox).toHaveBeenCalledTimes(1);
    expect(apiMock.createSandboxSnapshot).toHaveBeenCalledTimes(1);
    expect(apiMock.startSandbox).not.toHaveBeenCalled();
  });

  it("throws if the VM enters a terminal error state during capture", async () => {
    // stop ok, then the snapshot phase reports a terminal error.
    queueStates("stopped", "error");

    const promise = captureVmSandboxSnapshot(
      config,
      "sbx-1",
      "org/sandbox/snap",
      900,
      false,
    );
    // Surface the rejection without an unhandled-rejection warning.
    const settled = promise.then(
      () => "resolved",
      (err: Error) => err.message,
    );
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(settled).resolves.toContain("terminal state");
    expect(apiMock.startSandbox).not.toHaveBeenCalled();
  });

  it("restarts a kept source even when the stop phase fails", async () => {
    // Regression guard: the stop + stop-wait run inside the try, so a failure
    // there (here: the VM reports a terminal error during the stop wait) must
    // still trigger the keep-path restart in the finally — otherwise a full
    // capture would leave the source powered off while its row reads `active`.
    // stop-wait → error (throws); restart-wait → started.
    queueStates("error", "started");

    const promise = captureVmSandboxSnapshot(
      config,
      "sbx-1",
      "org/sandbox/snap",
      900,
      true,
    );
    const settled = promise.then(
      () => "resolved",
      (err: Error) => err.message,
    );
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(settled).resolves.toContain("terminal state");
    // The snapshot never happened, but the source is restarted for the keep path.
    expect(apiMock.createSandboxSnapshot).not.toHaveBeenCalled();
    expect(apiMock.startSandbox).toHaveBeenCalledTimes(1);
  });
});

describe("createVmSandbox", () => {
  const params = {
    name: "kiln-worker",
    snapshot: "org/sandbox/snap",
    env: { AMIKA_AGENT_CWD: "/home/daytona/repo" },
    labels: undefined,
    autoStopInterval: 30,
    autoDeleteInterval: 60,
    timeoutSeconds: 300,
  };

  beforeEach(() => {
    vi.useFakeTimers();
    apiMock.createSandbox
      .mockReset()
      .mockResolvedValue({ data: { id: "sbx-new" } });
    apiMock.deleteSandbox.mockReset().mockResolvedValue({ data: {} });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("waits for STARTED before returning the sandbox id", async () => {
    // createSandbox resolves while the VM is still booting; the started-wait
    // is what closes the race that otherwise fails initialize's first adapter exec
    // against a not-yet-running VM ("sandbox is in stopped state").
    queueStates("creating", "started");

    const promise = createVmSandbox(config, params);
    // One poll gap while the VM finishes booting (CREATING → STARTED).
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(promise).resolves.toBe("sbx-new");
    expect(apiMock.createSandbox).toHaveBeenCalledTimes(1);
    // No cleanup on the happy path.
    expect(apiMock.deleteSandbox).not.toHaveBeenCalled();
  });

  it("deletes the orphaned VM and rethrows when the start wait fails", async () => {
    // The VM was created but never reached STARTED. The caller's create-error
    // path can't clean it up (it never got the id) and autoDeleteInterval is
    // -1, so createVmSandbox must delete the VM itself before rethrowing.
    queueStates("archived");

    const promise = createVmSandbox(config, params);
    const settled = promise.then(
      () => "resolved",
      (err: Error) => err.message,
    );

    // The original wait failure surfaces...
    await expect(settled).resolves.toContain("terminal state");
    // ...and the orphaned VM is deleted.
    expect(apiMock.deleteSandbox).toHaveBeenCalledWith(
      "sbx-new",
      undefined,
      expect.objectContaining({ timeout: expect.any(Number) }),
    );
  });

  it("retries cleanup delete on a state-change-in-progress 400", async () => {
    // A wait timeout often means Daytona is mid-transition, so the delete can
    // hit `400 state change in progress`; it must retry rather than leak.
    queueStates("archived");
    // Real axios errors are Error instances with `.response` attached.
    const stateChangeErr = Object.assign(
      new Error("state change in progress"),
      { response: { status: 400, data: "state change in progress" } },
    );
    apiMock.deleteSandbox
      .mockRejectedValueOnce(stateChangeErr)
      .mockResolvedValueOnce({ data: {} });

    const promise = createVmSandbox(config, params);
    const settled = promise.then(
      () => "resolved",
      (err: Error) => err.message,
    );
    // Advance through the retry backoff.
    await vi.advanceTimersByTimeAsync(5_000);

    await expect(settled).resolves.toContain("terminal state");
    expect(apiMock.deleteSandbox).toHaveBeenCalledTimes(2);
  });

  it("retries cleanup delete on a structured state-change body", async () => {
    // Daytona may send the reason as a structured body under a non-`message`
    // key; the retry predicate must still recognize it.
    queueStates("archived");
    const structuredErr = Object.assign(new Error("Request failed"), {
      response: { status: 400, data: { error: "state change in progress" } },
    });
    apiMock.deleteSandbox
      .mockRejectedValueOnce(structuredErr)
      .mockResolvedValueOnce({ data: {} });

    const promise = createVmSandbox(config, params);
    const settled = promise.then(
      () => "resolved",
      (err: Error) => err.message,
    );
    await vi.advanceTimersByTimeAsync(5_000);

    await expect(settled).resolves.toContain("terminal state");
    expect(apiMock.deleteSandbox).toHaveBeenCalledTimes(2);
  });

  it("does not retry a non-state-change cleanup failure", async () => {
    // Best-effort cleanup: a non-retryable delete failure is swallowed after
    // one attempt and must not mask the original wait error.
    queueStates("archived");
    apiMock.deleteSandbox.mockRejectedValue(new Error("delete boom"));

    const promise = createVmSandbox(config, params);
    const settled = promise.then(
      () => "resolved",
      (err: Error) => err.message,
    );

    await expect(settled).resolves.toContain("terminal state");
    expect(apiMock.deleteSandbox).toHaveBeenCalledTimes(1);
  });
});

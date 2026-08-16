import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DaytonaError } from "@daytonaio/sdk";
import type { DaytonaConfig } from "../config";
import {
  captureDaytonaSandboxSnapshot,
  ensureDaytonaSnapshotActive,
  waitForDaytonaSnapshotActive,
} from "./snapshot-operations";

const getSnapshot = vi.fn();
const listSnapshots = vi.fn();
const activateSnapshot = vi.fn();
const getSandbox = vi.fn();
const stopDockerMock = vi.fn();
const startDockerMock = vi.fn();
const captureVmSnapshotMock = vi.fn();
const isVmSandboxMock = vi.fn();

// One client for everything: the capture, the docker quiesce/restore, and
// the snapshot reads all run against the configured target.
vi.mock("./client", () => ({
  getDaytonaClient: () => ({
    get: (id: string) => getSandbox(id),
    snapshot: {
      get: (name: string) => getSnapshot(name),
      list: (page: number, limit: number) => listSnapshots(page, limit),
      activate: (snapshot: unknown) => activateSnapshot(snapshot),
    },
  }),
}));

vi.mock("./configure", () => ({
  stopDockerForSnapshot: (...args: unknown[]) => stopDockerMock(...args),
  startDockerForSnapshot: (...args: unknown[]) => startDockerMock(...args),
}));

vi.mock("./vm", () => ({
  captureVmSandboxSnapshot: (...args: unknown[]) =>
    captureVmSnapshotMock(...args),
  isVmSandbox: (...args: unknown[]) => isVmSandboxMock(...args),
}));

const config: DaytonaConfig = {
  apiKey: "key",
  apiUrl: "https://daytona.example",
  target: undefined,
  organizationId: undefined,
  useVm: false,
};

const notFound = () => new DaytonaError("not found", 404);
const emptyList = { items: [], total: 0, page: 1, totalPages: 1 };

describe("waitForDaytonaSnapshotActive", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    getSnapshot.mockReset();
    listSnapshots.mockReset();
    listSnapshots.mockResolvedValue(emptyList);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("polls through 404s and non-active states until the snapshot is active", async () => {
    getSnapshot
      .mockRejectedValueOnce(notFound())
      .mockResolvedValueOnce({ state: "pending" })
      .mockResolvedValueOnce({ state: "active", name: "org/sandbox/snap" });

    const promise = waitForDaytonaSnapshotActive(config, "org/sandbox/snap");
    await vi.advanceTimersByTimeAsync(2_000); // sleep after the 404
    await vi.advanceTimersByTimeAsync(2_000); // sleep after "pending"

    await expect(promise).resolves.toMatchObject({ state: "active" });
    expect(getSnapshot).toHaveBeenCalledTimes(3);
    expect(getSnapshot).toHaveBeenCalledWith("org/sandbox/snap");
  });

  it("finds a building snapshot via the list when get-by-name 404s", async () => {
    getSnapshot.mockRejectedValue(notFound());
    listSnapshots
      .mockResolvedValueOnce({
        items: [{ name: "org/sandbox/snap", state: "building" }],
        total: 1,
        page: 1,
        totalPages: 1,
      })
      .mockResolvedValueOnce({
        items: [{ name: "org/sandbox/snap", state: "active" }],
        total: 1,
        page: 1,
        totalPages: 1,
      });

    const promise = waitForDaytonaSnapshotActive(config, "org/sandbox/snap");
    await vi.advanceTimersByTimeAsync(2_000); // sleep after "building"

    await expect(promise).resolves.toMatchObject({ state: "active" });
    expect(listSnapshots).toHaveBeenCalledTimes(2);
  });

  it("scans multiple list pages for the snapshot", async () => {
    getSnapshot.mockRejectedValue(notFound());
    listSnapshots
      .mockResolvedValueOnce({
        items: [{ name: "org/sandbox/other", state: "active" }],
        total: 2,
        page: 1,
        totalPages: 2,
      })
      .mockResolvedValueOnce({
        items: [{ name: "org/sandbox/snap", state: "active" }],
        total: 2,
        page: 2,
        totalPages: 2,
      });

    await expect(
      waitForDaytonaSnapshotActive(config, "org/sandbox/snap"),
    ).resolves.toMatchObject({ state: "active" });
    expect(listSnapshots).toHaveBeenNthCalledWith(1, 1, 100);
    expect(listSnapshots).toHaveBeenNthCalledWith(2, 2, 100);
  });

  it("throws when the snapshot enters a terminal failure state", async () => {
    getSnapshot.mockResolvedValueOnce({
      state: "build_failed",
      errorReason: "image push failed",
    });

    await expect(
      waitForDaytonaSnapshotActive(config, "org/sandbox/snap"),
    ).rejects.toThrow(
      'entered terminal state "build_failed": image push failed',
    );
  });

  it("throws when the snapshot never becomes active within the timeout", async () => {
    getSnapshot.mockResolvedValue({ state: "pending" });

    const promise = waitForDaytonaSnapshotActive(config, "org/sandbox/snap", 5);
    const assertion = expect(promise).rejects.toThrow(
      'did not become active within 5s (last state: "pending")',
    );
    await vi.advanceTimersByTimeAsync(6_000);
    await assertion;
  });

  it("reports a snapshot that never appeared when timing out on 404s", async () => {
    getSnapshot.mockRejectedValue(notFound());

    const promise = waitForDaytonaSnapshotActive(config, "org/sandbox/snap", 5);
    const assertion = expect(promise).rejects.toThrow(
      "never appeared in the snapshot list",
    );
    await vi.advanceTimersByTimeAsync(6_000);
    await assertion;
  });

  it("rethrows non-404 errors immediately", async () => {
    getSnapshot.mockRejectedValueOnce(new DaytonaError("boom", 500));

    await expect(
      waitForDaytonaSnapshotActive(config, "org/sandbox/snap"),
    ).rejects.toThrow("boom");
    expect(getSnapshot).toHaveBeenCalledTimes(1);
    expect(listSnapshots).not.toHaveBeenCalled();
  });
});

describe("captureDaytonaSandboxSnapshot", () => {
  beforeEach(() => {
    getSandbox.mockReset();
    stopDockerMock.mockReset();
    startDockerMock.mockReset();
    captureVmSnapshotMock.mockReset();
    isVmSandboxMock.mockReset();
    // Default: the sandbox is a container, so the VM path is skipped even when
    // `useVm` is set. Tests exercising the VM path opt in explicitly.
    isVmSandboxMock.mockResolvedValue(false);
  });

  it("captures a VM cold via the api-client, forwarding the keep-source intent", async () => {
    // VM mode snapshots the VM *cold*: `captureVmSandboxSnapshot` stops the
    // whole VM (which also quiesces the inner Docker daemon) and takes a
    // memory-excluded snapshot, so the container Docker stop/start dance is
    // neither needed nor used, and the capture goes through the VM helper
    // rather than the container snapshot call.
    getSandbox.mockResolvedValue({ id: "sandbox-handle" });
    isVmSandboxMock.mockResolvedValue(true);
    captureVmSnapshotMock.mockResolvedValue(undefined);

    await captureDaytonaSandboxSnapshot(
      { ...config, useVm: true },
      "sbx-1",
      "org/sandbox/snap",
      { keepSourceRunning: false },
    );
    // Delete-intent skips the power-restart (a stopped VM stays recoverable
    // via Start): the trailing `restartAfterCapture` arg is false.
    expect(captureVmSnapshotMock).toHaveBeenCalledWith(
      expect.objectContaining({ useVm: true }),
      "sbx-1",
      "org/sandbox/snap",
      expect.any(Number),
      false,
    );
    expect(stopDockerMock).not.toHaveBeenCalled();
    expect(startDockerMock).not.toHaveBeenCalled();
    expect(getSandbox).not.toHaveBeenCalled();

    await captureDaytonaSandboxSnapshot(
      { ...config, useVm: true },
      "sbx-1",
      "org/sandbox/snap",
      { keepSourceRunning: true },
    );
    // Keep-source restarts the VM after the cold capture.
    expect(captureVmSnapshotMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ useVm: true }),
      "sbx-1",
      "org/sandbox/snap",
      expect.any(Number),
      true,
    );
  });

  it("uses the container path when useVm is set but the sandbox is a container", async () => {
    // A container created before the flag was enabled must not hit the VM
    // snapshot call (Daytona rejects it); the real class governs the branch.
    const sandbox = {
      id: "sandbox-handle",
      createSnapshot: vi.fn().mockResolvedValue(undefined),
    };
    getSandbox.mockResolvedValue(sandbox);
    isVmSandboxMock.mockResolvedValue(false);
    stopDockerMock.mockResolvedValue(undefined);
    startDockerMock.mockResolvedValue(undefined);

    await captureDaytonaSandboxSnapshot(
      { ...config, useVm: true },
      "sbx-1",
      "org/sandbox/snap",
      { keepSourceRunning: false },
    );

    expect(captureVmSnapshotMock).not.toHaveBeenCalled();
    expect(sandbox.createSnapshot).toHaveBeenCalledWith(
      "org/sandbox/snap",
      expect.any(Number),
    );
    expect(startDockerMock).toHaveBeenCalledWith(sandbox);
  });

  it("keep-source container capture snapshots hot — no docker quiesce", async () => {
    // Today's full-capture behavior: a kept-alive container is snapshotted
    // without stopping dockerd (the quiesce exists to protect a snapshot that
    // will be booted as the org base, and the destructive path covers that).
    const sandbox = {
      id: "sandbox-handle",
      createSnapshot: vi.fn().mockResolvedValue(undefined),
    };
    getSandbox.mockResolvedValue(sandbox);

    await captureDaytonaSandboxSnapshot(config, "sbx-1", "org/sandbox/snap", {
      keepSourceRunning: true,
    });

    expect(stopDockerMock).not.toHaveBeenCalled();
    expect(startDockerMock).not.toHaveBeenCalled();
    expect(sandbox.createSnapshot).toHaveBeenCalledWith(
      "org/sandbox/snap",
      expect.any(Number),
    );
  });

  it("delete-intent container capture stops docker before and restarts after", async () => {
    // Docker stops right before capture so /var/lib/docker is frozen at rest,
    // then restarts right after so a kept (delete-failed) source isn't left
    // down.
    const calls: string[] = [];
    const sandbox = {
      id: "sandbox-handle",
      createSnapshot: vi.fn(async () => {
        calls.push("capture");
      }),
    };
    getSandbox.mockResolvedValue(sandbox);
    stopDockerMock.mockImplementation(async () => {
      calls.push("stop-docker");
    });
    startDockerMock.mockImplementation(async () => {
      calls.push("start-docker");
    });

    await captureDaytonaSandboxSnapshot(config, "sbx-1", "org/sandbox/snap", {
      keepSourceRunning: false,
    });

    expect(calls).toEqual(["stop-docker", "capture", "start-docker"]);
    expect(stopDockerMock).toHaveBeenCalledWith(sandbox);
    expect(startDockerMock).toHaveBeenCalledWith(sandbox);
  });

  it("restarts docker even when the capture fails", async () => {
    // A failed capture leaves the source sandbox alive (restored to `active`
    // by the caller), so Docker must come back up rather than stay stopped
    // from the pre-capture quiesce.
    const sandbox = {
      id: "sandbox-handle",
      createSnapshot: vi.fn().mockRejectedValue(new Error("boom")),
    };
    getSandbox.mockResolvedValue(sandbox);
    stopDockerMock.mockResolvedValue(undefined);
    startDockerMock.mockResolvedValue(undefined);

    await expect(
      captureDaytonaSandboxSnapshot(config, "sbx-1", "org/sandbox/snap", {
        keepSourceRunning: false,
      }),
    ).rejects.toThrow("boom");
    expect(startDockerMock).toHaveBeenCalledWith(sandbox);
  });

  it("never touches docker when the sandbox handle cannot be resolved", async () => {
    // The `get` runs before the quiesce, so a failure to resolve the handle
    // leaves the source exactly as it was — nothing to restore.
    getSandbox.mockRejectedValue(new Error("target down"));

    await expect(
      captureDaytonaSandboxSnapshot(config, "sbx-1", "org/sandbox/snap", {
        keepSourceRunning: false,
      }),
    ).rejects.toThrow("target down");
    expect(stopDockerMock).not.toHaveBeenCalled();
    expect(startDockerMock).not.toHaveBeenCalled();
  });
});

describe("ensureDaytonaSnapshotActive", () => {
  beforeEach(() => {
    getSnapshot.mockReset();
    listSnapshots.mockReset();
    activateSnapshot.mockReset();
    listSnapshots.mockResolvedValue(emptyList);
  });

  it("is a no-op for an already-active snapshot", async () => {
    getSnapshot.mockResolvedValueOnce({
      state: "active",
      name: "org/sandbox/snap",
    });

    await expect(
      ensureDaytonaSnapshotActive(config, "org/sandbox/snap"),
    ).resolves.toBe(false);
    expect(activateSnapshot).not.toHaveBeenCalled();
    expect(getSnapshot).toHaveBeenCalledTimes(1);
  });

  it("reactivates an inactive snapshot and waits for it to go active", async () => {
    getSnapshot
      .mockResolvedValueOnce({ state: "inactive", name: "org/sandbox/snap" }) // ensure's state read
      .mockResolvedValueOnce({ state: "inactive", name: "org/sandbox/snap" }) // activate's own get
      .mockResolvedValueOnce({ state: "active", name: "org/sandbox/snap" }); // waitForActive poll
    activateSnapshot.mockResolvedValue({
      state: "pending",
      name: "org/sandbox/snap",
    });

    await expect(
      ensureDaytonaSnapshotActive(config, "org/sandbox/snap"),
    ).resolves.toBe(true);
    expect(activateSnapshot).toHaveBeenCalledTimes(1);
  });

  it("does not block creation when the snapshot is missing (404)", async () => {
    getSnapshot.mockRejectedValueOnce(notFound());

    await expect(
      ensureDaytonaSnapshotActive(config, "org/sandbox/snap"),
    ).resolves.toBe(false);
    expect(activateSnapshot).not.toHaveBeenCalled();
  });

  it("swallows transient (non-404) Daytona API read errors rather than failing the create", async () => {
    getSnapshot.mockRejectedValueOnce(new DaytonaError("boom", 500));

    await expect(
      ensureDaytonaSnapshotActive(config, "org/sandbox/snap"),
    ).resolves.toBe(false);
    expect(activateSnapshot).not.toHaveBeenCalled();
  });

  it("propagates non-API errors instead of masking them", async () => {
    // A non-DaytonaError (e.g. an unexpected client shape / programming bug)
    // must surface rather than be swallowed as a best-effort read failure.
    getSnapshot.mockRejectedValueOnce(
      new TypeError("daytona.snapshot is undefined"),
    );

    await expect(
      ensureDaytonaSnapshotActive(config, "org/sandbox/snap"),
    ).rejects.toThrow("daytona.snapshot is undefined");
    expect(activateSnapshot).not.toHaveBeenCalled();
  });

  it("leaves a non-inactive (e.g. terminal) snapshot untouched", async () => {
    getSnapshot.mockResolvedValueOnce({
      state: "build_failed",
      name: "org/sandbox/snap",
    });

    await expect(
      ensureDaytonaSnapshotActive(config, "org/sandbox/snap"),
    ).resolves.toBe(false);
    expect(activateSnapshot).not.toHaveBeenCalled();
  });
});

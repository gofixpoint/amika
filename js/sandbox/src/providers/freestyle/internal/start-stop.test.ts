import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FreestyleConfig } from "../config";
import { startFreestyleSandbox, stopFreestyleSandbox } from "./operations";

const startVm = vi.fn();
const stopVm = vi.fn();
const suspendVm = vi.fn();
const listVms = vi.fn();

vi.mock("./client", () => ({
  FREESTYLE_CONTROL_PLANE_TIMEOUT_MS: 1,
  createFreestyleClient: () => ({
    vms: {
      ref: () => ({ start: startVm, stop: stopVm, suspend: suspendVm }),
      list: listVms,
    },
  }),
}));

const config: FreestyleConfig = { apiKey: "test-key" };

// `getFreestyleSandboxState` reads the VM's state from `vms.list`. Queue a state
// per poll; the last value repeats so a loop that polls more than once settles.
function queueStates(...states: string[]): void {
  listVms.mockReset();
  states.forEach((state, i) => {
    const value = { vms: [{ id: "vm_1", state }] };
    if (i === states.length - 1) listVms.mockResolvedValue(value);
    else listVms.mockResolvedValueOnce(value);
  });
}

beforeEach(() => {
  startVm.mockReset().mockResolvedValue(undefined);
  stopVm.mockReset().mockResolvedValue(undefined);
  suspendVm.mockReset().mockResolvedValue(undefined);
  listVms.mockReset();
});

describe("stopFreestyleSandbox", () => {
  it("suspends (not stops) a running VM and waits for it to settle", async () => {
    queueStates("running", "suspended");

    await stopFreestyleSandbox(config, "vm_1");

    // Suspend, not stop: a stopped VM cold-boots on resume and wedges in
    // `starting`; a suspended VM resumes from its suspend layer.
    expect(suspendVm).toHaveBeenCalledTimes(1);
    expect(stopVm).not.toHaveBeenCalled();
    // Polled the state at least once after suspending, to confirm it settled.
    expect(listVms.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("is a no-op when the VM is already suspended", async () => {
    queueStates("suspended");

    await stopFreestyleSandbox(config, "vm_1");

    // `vm.suspend` on an already-suspended VM is a 409, so it must be skipped.
    expect(suspendVm).not.toHaveBeenCalled();
  });

  it("skips both the suspend and the wait when the VM is already stopped", async () => {
    queueStates("stopped");

    await stopFreestyleSandbox(config, "vm_1");

    expect(suspendVm).not.toHaveBeenCalled();
    expect(stopVm).not.toHaveBeenCalled();
    // Only the guard read — no settle-poll loop for an already-idle VM.
    expect(listVms).toHaveBeenCalledTimes(1);
  });

  it("fails fast (no 2-minute poll) when the VM has gone missing", async () => {
    // Guard sees the VM running → suspends; the settle poll then finds it absent.
    queueStates("running", "unknown");

    await expect(stopFreestyleSandbox(config, "vm_1")).rejects.toThrow(
      /unknown/,
    );
    expect(suspendVm).toHaveBeenCalledTimes(1);
  });
});

describe("startFreestyleSandbox", () => {
  it("resumes immediately when the VM is suspended", async () => {
    queueStates("suspended");

    await startFreestyleSandbox(config, "vm_1");

    expect(startVm).toHaveBeenCalledTimes(1);
  });

  it("waits for an in-flight suspend to settle before resuming", async () => {
    // First poll (the guard) sees the VM still suspending; the next sees it
    // settled. `vm.start` must only fire once the VM is fully suspended —
    // resuming mid-transition is what wedges the VM in `starting`.
    queueStates("suspending", "suspended");

    await startFreestyleSandbox(config, "vm_1");

    expect(startVm).toHaveBeenCalledTimes(1);
    expect(listVms.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("waits for an in-flight stop to settle before resuming", async () => {
    // A VM mid cold-stop (e.g. a suspend that fell back to stopping) must
    // finish stopping before `vm.start` resumes it.
    queueStates("stopping", "stopped");

    await startFreestyleSandbox(config, "vm_1");

    expect(startVm).toHaveBeenCalledTimes(1);
    expect(listVms.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});

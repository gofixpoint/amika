import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FreestyleConfig } from "../config";
import { startFreestyleSandbox, stopFreestyleSandbox } from "./operations";

const startVm = vi.fn();
const stopVm = vi.fn();
const suspendVm = vi.fn();
const execVm = vi.fn();
const listVms = vi.fn();

vi.mock("./client", () => ({
  FREESTYLE_CONTROL_PLANE_TIMEOUT_MS: 1,
  createFreestyleClient: () => ({
    vms: {
      ref: () => ({
        start: startVm,
        stop: stopVm,
        suspend: suspendVm,
        exec: execVm,
      }),
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
  execVm.mockReset().mockRejectedValue(new Error("guest disconnected"));
  listVms.mockReset();
});

describe("stopFreestyleSandbox", () => {
  it("powers off a running VM and waits for it to stop", async () => {
    queueStates("running", "stopped");

    await stopFreestyleSandbox(config, "vm_1");

    expect(execVm).toHaveBeenCalledWith({ command: "sudo poweroff" });
    expect(stopVm).not.toHaveBeenCalled();
    expect(suspendVm).not.toHaveBeenCalled();
    // Polled the state after stop to confirm it settled.
    expect(listVms.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("powers off an already suspended VM", async () => {
    queueStates("suspended", "stopped");

    await stopFreestyleSandbox(config, "vm_1");

    expect(startVm).toHaveBeenCalledTimes(1);
    expect(execVm).toHaveBeenCalledWith({ command: "sudo poweroff" });
    expect(suspendVm).not.toHaveBeenCalled();
  });

  it("waits for an in-flight suspend before powering off", async () => {
    queueStates("suspending", "suspended", "stopped");

    await stopFreestyleSandbox(config, "vm_1");

    expect(startVm).toHaveBeenCalledTimes(1);
    expect(execVm).toHaveBeenCalledWith({ command: "sudo poweroff" });
  });

  it("waits for an existing cold stop without issuing another poweroff", async () => {
    queueStates("stopping", "stopped");

    await stopFreestyleSandbox(config, "vm_1");

    expect(execVm).not.toHaveBeenCalled();
    expect(startVm).not.toHaveBeenCalled();
  });

  it("skips stop and the wait when the VM is already stopped", async () => {
    queueStates("stopped");

    await stopFreestyleSandbox(config, "vm_1");

    expect(suspendVm).not.toHaveBeenCalled();
    expect(stopVm).not.toHaveBeenCalled();
    expect(execVm).not.toHaveBeenCalled();
    // Only the guard read — no settle-poll loop for an already-stopped VM.
    expect(listVms).toHaveBeenCalledTimes(1);
  });

  it("fails fast (no 2-minute poll) when the VM has gone missing", async () => {
    // Guard sees the VM running → stops; the settle poll then finds it absent.
    queueStates("running", "unknown");

    await expect(stopFreestyleSandbox(config, "vm_1")).rejects.toThrow(
      /unknown/,
    );
    expect(execVm).toHaveBeenCalledTimes(1);
  });
});

describe("startFreestyleSandbox", () => {
  it("resumes immediately when the VM is suspended", async () => {
    queueStates("suspended");

    await startFreestyleSandbox(config, "vm_1", 30);

    expect(startVm).toHaveBeenCalledTimes(1);
    expect(startVm).toHaveBeenCalledWith({
      idleTimeoutSeconds: 365 * 24 * 60 * 60,
    });
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

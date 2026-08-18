import { describe, expect, it } from "vitest";
import { stopDockerForSnapshot, startDockerForSnapshot } from "./configure";
import { fakeDaytonaSandbox } from "./test-support";

describe("stopDockerForSnapshot", () => {
  it("runs a single root bash teardown that no-ops without dockerd", async () => {
    const { sandbox, commands } = fakeDaytonaSandbox();

    await stopDockerForSnapshot(
      sandbox as Parameters<typeof stopDockerForSnapshot>[0],
    );

    expect(commands).toHaveLength(1);
    const command = commands[0]!.command;
    // Runs as root (the daemon/containerd stop needs it)...
    expect(command).toContain("sudo -n");
    // ...wrapped in `bash -c` so the multi-line script runs as one unit.
    expect(command).toContain("bash -c ");
    // No-ops when dockerd isn't installed (non-dind preset).
    expect(command).toContain("command -v dockerd >/dev/null 2>&1 || exit 0");
    // Docker CLI calls are bounded by `timeout` so a wedged daemon can't
    // hang the teardown before it reaches the pkill fallback.
    expect(command).toContain("timeout 30 docker ps");
    expect(command).toContain("timeout 60 docker stop");
    // Stops the daemon, waits for it to exit, then stops containerd.
    expect(command).toContain("pkill -TERM dockerd");
    expect(command).toContain("pgrep -x dockerd");
    expect(command).toContain("pkill -TERM containerd");
  });
});

describe("startDockerForSnapshot", () => {
  it("runs a single root bash restart that no-ops without dockerd", async () => {
    const { sandbox, commands } = fakeDaytonaSandbox();

    await startDockerForSnapshot(
      sandbox as Parameters<typeof startDockerForSnapshot>[0],
    );

    expect(commands).toHaveLength(1);
    const command = commands[0]!.command;
    // Runs as root, wrapped in `bash -c`.
    expect(command).toContain("sudo -n");
    expect(command).toContain("bash -c ");
    // No-ops when dockerd isn't installed.
    expect(command).toContain("command -v dockerd >/dev/null 2>&1 || exit 0");
    // Only starts the daemon if it isn't already running.
    expect(command).toContain("if ! pgrep -x dockerd");
    // Falls back to relaunching dockerd directly (no systemd on Daytona).
    expect(command).toContain("nohup dockerd");
    // Restarts the containers the stop step recorded.
    expect(command).toContain("amika-snapshot-running-containers");
    expect(command).toContain("docker start");
  });

  it("never throws when the restart exec fails", async () => {
    // Invoked in a `finally` after a successful capture, so a restart
    // failure must not surface and mask the capture's success.
    const sandbox = {
      process: {
        executeCommand: () => Promise.reject(new Error("exec down")),
      },
    } as unknown as Parameters<typeof startDockerForSnapshot>[0];

    await expect(startDockerForSnapshot(sandbox)).resolves.toBeUndefined();
  });
});

import { describe, expect, it, vi } from "vitest";
import {
  cloneRepository,
  stopDockerForSnapshot,
  startDockerForSnapshot,
} from "./configure";
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

describe("native clone guest branch probe", () => {
  it.each([
    [{ exitCode: 0, stdout: "" }, true],
    [{ exitCode: 0, stdout: "sha\trefs/heads/feature\n" }, false],
    [{ exitCode: 128, stdout: "", stderr: "Authentication failed" }, false],
  ] as const)(
    "probes through Daytona guest execution for %j",
    async (probe, fallback) => {
      const { sandbox, commands } = fakeDaytonaSandbox((command) =>
        command.includes("ls-remote") ? probe : {},
      );
      const failure = new Error("SDK clone failure");
      const clone = vi
        .fn()
        .mockRejectedValueOnce(failure)
        .mockResolvedValue(undefined);
      const native = Object.assign(sandbox as object, {
        git: { clone },
      }) as unknown as Parameters<typeof cloneRepository>[0];
      const result = cloneRepository(
        native,
        "/home/amika",
        "ssh://git@customer.internal/org/repo.git",
        "repo",
        null,
        "feature",
      );
      if (fallback) await expect(result).resolves.toBeUndefined();
      else await expect(result).rejects.toBe(failure);
      const probes = commands.filter(({ command }) =>
        command.includes("ls-remote"),
      );
      expect(probes).toHaveLength(1);
      expect(probes[0].command).toContain(
        "ssh://git@customer.internal/org/repo.git",
      );
      expect(probes[0].cwd).toBe("/home/amika");
      expect(clone).toHaveBeenCalledTimes(fallback ? 2 : 1);
    },
  );
});

describe("native GitHub clone credentials", () => {
  it.each([
    "https://gitlab.com/org/repo.git",
    "https://github.com.evil.example/org/repo.git",
    "https://github.com./org/repo.git",
    "https://github.com\\@evil.example/org/repo.git",
    "https://github.com\\evil.example@evil.example/org/repo.git",
    "http://github.com/org/repo.git",
    "ssh://git@github.com/org/repo.git",
    "git@github.com:org/repo.git",
  ])(
    "does not attach a GitHub token to %s, including branch fallback",
    async (url) => {
      const { sandbox, commands } = fakeDaytonaSandbox();
      const clone = vi
        .fn()
        .mockRejectedValueOnce(new Error("SDK clone failure"))
        .mockResolvedValue(undefined);
      const native = Object.assign(sandbox as object, {
        git: { clone },
      }) as unknown as Parameters<typeof cloneRepository>[0];
      await cloneRepository(
        native,
        "/home/amika",
        url,
        "repo",
        "sentinel-github-token",
        "feature",
      );
      expect(clone).toHaveBeenCalledTimes(2);
      for (const args of clone.mock.calls) {
        expect(args[0]).toBe(url);
        expect(args[4]).toBeUndefined();
        expect(args[5]).toBeUndefined();
      }
      expect(
        commands.find(({ command }) => command.includes("ls-remote"))?.command,
      ).not.toContain("sentinel-github-token");
    },
  );

  it("authenticates native HTTPS GitHub clones and fallback with the same token", async () => {
    const { sandbox } = fakeDaytonaSandbox();
    const clone = vi
      .fn()
      .mockRejectedValueOnce(new Error("SDK clone failure"))
      .mockResolvedValue(undefined);
    const native = Object.assign(sandbox as object, {
      git: { clone },
    }) as unknown as Parameters<typeof cloneRepository>[0];
    await cloneRepository(
      native,
      "/home/amika",
      "https://github.com/org/repo.git",
      "repo",
      "sentinel-github-token",
      "feature",
    );
    expect(clone).toHaveBeenCalledTimes(2);
    for (const args of clone.mock.calls) {
      expect(args[4]).toBe("x-access-token");
      expect(args[5]).toBe("sentinel-github-token");
    }
  });
});

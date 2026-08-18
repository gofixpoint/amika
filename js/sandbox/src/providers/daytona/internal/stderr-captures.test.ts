import { beforeEach, describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DaytonaConfig } from "../config";
import { STDERR_CAPTURE_PREFIX } from "./commands";
import { removeStderrCaptureFiles } from "./stderr-captures";

const getSandbox = vi.fn();
const execMock = vi.fn();

vi.mock("./client", () => ({
  getDaytonaClient: () => ({ get: (id: string) => getSandbox(id) }),
}));

vi.mock("./commands", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./commands")>();
  return {
    ...actual,
    executeCommand: (...args: unknown[]) => execMock(...args),
  };
});

const config: DaytonaConfig = {
  apiKey: "key",
  apiUrl: "https://daytona.example",
  target: undefined,
  organizationId: undefined,
  useVm: false,
};

describe("removeStderrCaptureFiles", () => {
  beforeEach(() => {
    getSandbox.mockReset();
    execMock.mockReset();
    getSandbox.mockResolvedValue({ id: "sbx-1" });
    execMock.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
  });

  it("sweeps the capture files by their own prefix, not every temp file", async () => {
    // A bare `mktemp` name would force a `tmp.*` glob here, which would delete
    // unrelated tools' temp files mid-build. The prefix is what makes the sweep
    // targetable at all.
    await removeStderrCaptureFiles(config, "sbx-1");

    expect(execMock).toHaveBeenCalledTimes(1);
    const command = execMock.mock.calls[0]![1] as string;
    expect(command).toContain(`'${STDERR_CAPTURE_PREFIX}*'`);
    expect(command).not.toContain("tmp.*");
    // Bounded to the temp directory: an unanchored search would walk the
    // sandbox filesystem before every snapshot.
    expect(command).toContain('"${TMPDIR:-/tmp}"');
    expect(command).toContain("-maxdepth 1");
  });

  it("keeps a diagnostic reachable when the sweep deletes its own capture file", async () => {
    // The sweep's own stderr is being captured to a file the sweep itself
    // matches, so `find`'s stderr is folded into stdout — otherwise a failure
    // would report nothing at all.
    await removeStderrCaptureFiles(config, "sbx-1");

    expect(execMock.mock.calls[0]![1]).toContain("2>&1");
  });

  it("runs unprivileged, since the framing shell owns every capture file", async () => {
    await removeStderrCaptureFiles(config, "sbx-1");

    // `undefined` or no opts at all — either way, not `sudo: true`.
    const opts = execMock.mock.calls[0]![2] as { sudo?: boolean } | undefined;
    expect(opts?.sudo).toBeFalsy();
  });

  it("throws with the folded stdout diagnostic when the sweep fails", async () => {
    execMock.mockResolvedValue({
      exitCode: 1,
      stdout: "find: /tmp: Permission denied\n",
      stderr: "",
    });

    await expect(removeStderrCaptureFiles(config, "sbx-1")).rejects.toThrow(
      /Permission denied/u,
    );
  });

  it("resolves when there is nothing to remove", async () => {
    await expect(
      removeStderrCaptureFiles(config, "sbx-1"),
    ).resolves.toBeUndefined();
  });
});

// The generated command is only a string until a shell runs it. These execute it
// against a real directory, so a glob or `find` predicate that doesn't do what
// it reads as fails here.
describe.skipIf(process.platform !== "linux")(
  "removeStderrCaptureFiles (executed)",
  () => {
    beforeEach(() => {
      getSandbox.mockReset();
      execMock.mockReset();
      getSandbox.mockResolvedValue({ id: "sbx-1" });
      execMock.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
    });

    it("removes capture files and leaves every other temp file alone", async () => {
      await removeStderrCaptureFiles(config, "sbx-1");
      const command = execMock.mock.calls[0]![1] as string;

      const dir = mkdtempSync(join(tmpdir(), "sweep-"));
      try {
        // Two of ours, plus the shapes that must survive: another tool's
        // `mktemp` file, and an ordinary file.
        writeFileSync(
          join(dir, `${STDERR_CAPTURE_PREFIX}aaaaaaaaaa`),
          "secret",
        );
        writeFileSync(
          join(dir, `${STDERR_CAPTURE_PREFIX}bbbbbbbbbb`),
          "secret",
        );
        writeFileSync(join(dir, "tmp.someOtherTool"), "keep me");
        writeFileSync(join(dir, "important.log"), "keep me");

        const r = spawnSync("bash", ["-c", command], {
          encoding: "utf8",
          env: { ...process.env, TMPDIR: dir },
        });

        expect(r.status).toBe(0);
        expect(readdirSync(dir).sort()).toEqual([
          "important.log",
          "tmp.someOtherTool",
        ]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("succeeds when the temp directory holds no capture files", async () => {
      await removeStderrCaptureFiles(config, "sbx-1");
      const command = execMock.mock.calls[0]![1] as string;

      const dir = mkdtempSync(join(tmpdir(), "sweep-empty-"));
      try {
        const r = spawnSync("bash", ["-c", command], {
          encoding: "utf8",
          env: { ...process.env, TMPDIR: dir },
        });
        // `-exec … +` runs nothing when nothing matches, so this must not be a
        // non-zero "no such file" that the caller would report as a failure.
        expect(r.status).toBe(0);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  },
);

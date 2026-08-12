import { describe, expect, it } from "vitest";
import { scrubTargetsViaExec } from "./scrub-exec";
import {
  ScrubRestoreError,
  ScrubVerificationError,
  type ExecCapability,
  type ExecCommandOptions,
  type ScrubTargets,
} from "../provider";

const HOME = "/home/amika";
const WORKSPACE = `${HOME}/workspace`;

// Sample scrub targets. The mechanism removes exactly what it is handed and has
// no knowledge of which paths are Amika secrets, so any paths work here.
const FILES = [`${HOME}/.git-credentials`, `${HOME}/.claude`, `${HOME}/.codex`];
const SUDO_FILES = [
  "/etc/environment",
  "/usr/local/etc/amikad/service-env-vars.json",
];

function targets(overrides: Partial<ScrubTargets> = {}): ScrubTargets {
  return {
    files: FILES,
    sudoFiles: SUDO_FILES,
    sudoFileRestores: [],
    envVarNames: ["OPENAI_API_KEY"],
    gitTokenWorkspaceRoot: WORKSPACE,
    ...overrides,
  };
}

interface FakeExecOptions {
  /** Paths that currently exist (drive the `ls -1d` existence probe). */
  existing?: string[];
  /** Paths that survive `rm` (simulate a process recreating a scrubbed path). */
  sticky?: string[];
  /**
   * `.git/config` paths the git-remote verify (`grep -l 'x-access-token:'`)
   * still reports as tokenized — simulates a remote the sanitize missed.
   */
  gitRemoteLeftover?: string[];
  /** Make the baseline restore (`install`) fail, as a read-only fs would. */
  failRestore?: boolean;
  /** Make the post-restore SHA-256 verification fail. */
  restoreMismatch?: boolean;
  /** Exit code for a failed verification (default 1, a real difference). */
  restoreVerificationExitCode?: number;
}

/**
 * Minimal {@link ExecCapability} stand-in. `ls -1d` echoes the still-present
 * subset of the queried paths; `rm` drops matching paths from the present set
 * unless they are `sticky`. Everything else returns success.
 */
function fakeExec(opts: FakeExecOptions = {}): {
  exec: ExecCapability;
  calls: Array<{ command: string; opts?: ExecCommandOptions }>;
} {
  const present = new Set(opts.existing ?? []);
  const sticky = new Set(opts.sticky ?? []);
  const calls: Array<{ command: string; opts?: ExecCommandOptions }> = [];

  const exec: ExecCapability = {
    streaming: false,
    run: (_id, command, execOpts) => {
      calls.push({ command, opts: execOpts });
      if (command.startsWith("install ") && opts.failRestore) {
        return Promise.resolve({
          exitCode: 1,
          stdout: "",
          stderr: "install: cannot create regular file",
        });
      }
      if (command.startsWith("source_hash=$(sha256sum")) {
        return Promise.resolve({
          exitCode: opts.restoreMismatch
            ? (opts.restoreVerificationExitCode ?? 1)
            : 0,
          stdout: "",
          stderr: "",
        });
      }
      if (command.startsWith("ls -1d")) {
        const found = [...present].filter((p) => command.includes(p));
        return Promise.resolve({
          exitCode: found.length ? 0 : 1,
          stdout: found.join("\n"),
          stderr: "",
        });
      }
      if (command.startsWith("rm ")) {
        for (const p of [...present]) {
          if (command.includes(p) && !sticky.has(p)) present.delete(p);
        }
        return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" });
      }
      // The git-remote scrub: the sanitize (`sed`) succeeds silently; the verify
      // (`grep -l 'x-access-token:'`) reports any `.git/config` still tokenized.
      if (command.includes("x-access-token")) {
        return Promise.resolve({
          exitCode: 0,
          stdout: command.includes("grep -l")
            ? (opts.gitRemoteLeftover ?? []).join("\n")
            : "",
          stderr: "",
        });
      }
      return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" });
    },
  };

  return { exec, calls };
}

describe("scrubTargetsViaExec", () => {
  it("restores declared system baselines before removing other targets", async () => {
    const { exec, calls } = fakeExec({ existing: [...FILES, ...SUDO_FILES] });

    await scrubTargetsViaExec(
      exec,
      "sb_1",
      targets({
        sudoFileRestores: [
          {
            sourcePath: "/usr/local/etc/amikad/environment.base",
            destinationPath: "/etc/environment",
          },
        ],
      }),
    );

    expect(calls[0]?.command).toContain("environment.base");
    expect(calls[0]?.command).toContain("install -m 0644");
    expect(calls.at(-1)?.command).toContain("sha256sum");
  });

  it("verifies restored baselines even when no paths are removed", async () => {
    const { exec, calls } = fakeExec();

    await scrubTargetsViaExec(
      exec,
      "sb_1",
      targets({
        files: [],
        sudoFiles: [],
        sudoFileRestores: [
          {
            sourcePath: "/usr/local/etc/amikad/environment.base",
            destinationPath: "/etc/environment",
          },
        ],
      }),
    );

    expect(
      calls.some((call) => call.command.startsWith("source_hash=$(sha256sum")),
    ).toBe(true);
  });

  it("throws when the baseline restore itself fails", async () => {
    // The restore runs first, so a failure here means later commands would
    // scrub a sandbox whose `/etc/environment` was never put back.
    const { exec } = fakeExec({ failRestore: true });

    await expect(
      scrubTargetsViaExec(
        exec,
        "sb_1",
        targets({
          sudoFileRestores: [
            {
              sourcePath: "/usr/local/etc/amikad/environment.base",
              destinationPath: "/etc/environment",
            },
          ],
        }),
      ),
    ).rejects.toThrow(ScrubRestoreError);
  });

  it("fails closed when the restored baseline does not match its source", async () => {
    // The hash check is the only thing standing between a bad restore and a
    // captured snapshot, so a mismatch must abort rather than warn. It must not raise
    // ScrubVerificationError: that one means a path survived removal, which
    // the control plane blames on a live agent recreating files, and no agent
    // activity explains a restore that did not land.
    const { exec } = fakeExec({
      existing: [...FILES, ...SUDO_FILES],
      restoreMismatch: true,
    });

    const call = scrubTargetsViaExec(
      exec,
      "sb_1",
      targets({
        sudoFileRestores: [
          {
            sourcePath: "/usr/local/etc/amikad/environment.base",
            destinationPath: "/etc/environment",
          },
        ],
      }),
    );

    await expect(call).rejects.toThrow(ScrubRestoreError);
    await expect(call).rejects.not.toThrow(ScrubVerificationError);
  });

  it("fails closed when the hash verification cannot run", async () => {
    const { exec } = fakeExec({
      restoreMismatch: true,
      restoreVerificationExitCode: 127,
    });

    await expect(
      scrubTargetsViaExec(
        exec,
        "sb_1",
        targets({
          files: [],
          sudoFiles: [],
          sudoFileRestores: [
            {
              sourcePath: "/usr/local/etc/amikad/environment.base",
              destinationPath: "/etc/environment",
            },
          ],
        }),
      ),
    ).rejects.toThrow(/verification failed \(exit 127\)/u);
  });

  it("removes every passed credential + env file, then verifies", async () => {
    const { exec, calls } = fakeExec({ existing: [...FILES, ...SUDO_FILES] });

    await scrubTargetsViaExec(exec, "sb_1", targets());

    // Every credential path and managed env file was targeted by an rm.
    for (const path of [...FILES, ...SUDO_FILES]) {
      expect(
        calls.some(
          (c) => c.command.startsWith("rm ") && c.command.includes(path),
        ),
      ).toBe(true);
    }
    // Managed env files are removed with sudo; credential files as the user.
    for (const c of calls) {
      if (c.command.startsWith("rm -f ")) {
        expect(c.opts?.sudo).toBe(true);
      }
    }
  });

  it("resumes bare on every command — never restart-services", async () => {
    // On Vercel a generic exec against a stopped sandbox fires the
    // service-restart resume callback, which reloads the very secret being
    // scrubbed into a live session right before capture.
    const { exec, calls } = fakeExec({ existing: [...FILES, ...SUDO_FILES] });
    await scrubTargetsViaExec(exec, "sb_1", targets());
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) {
      expect(c.opts?.resumeMode).toBe("bare");
    }
  });

  it("throws ScrubVerificationError when a path survives the scrub", async () => {
    const survivor = FILES[0];
    const { exec } = fakeExec({
      existing: [...FILES, ...SUDO_FILES],
      sticky: [survivor],
    });

    await expect(
      scrubTargetsViaExec(exec, "sb_1", targets()),
    ).rejects.toBeInstanceOf(ScrubVerificationError);
  });

  it("sanitizes tokenized git remotes under the declared workspace root", async () => {
    const { exec, calls } = fakeExec({ existing: [...FILES, ...SUDO_FILES] });

    await scrubTargetsViaExec(exec, "sb_1", targets());

    // A `.git/config` sed rewrite that strips the `x-access-token:<token>@`
    // userinfo, scoped to config files under the declared workspace root.
    expect(
      calls.some(
        (c) =>
          c.command.includes(WORKSPACE) &&
          c.command.includes(".git/config") &&
          c.command.includes("x-access-token") &&
          c.command.includes("sed"),
      ),
    ).toBe(true);
  });

  it("skips the git-remote pass when no workspace root is declared", async () => {
    const { exec, calls } = fakeExec({ existing: [...FILES, ...SUDO_FILES] });
    await scrubTargetsViaExec(
      exec,
      "sb_1",
      targets({ gitTokenWorkspaceRoot: undefined }),
    );
    expect(calls.some((c) => c.command.includes("x-access-token"))).toBe(false);
  });

  it("throws ScrubVerificationError when a tokenized git remote survives", async () => {
    const { exec } = fakeExec({
      existing: [...FILES, ...SUDO_FILES],
      gitRemoteLeftover: [`${WORKSPACE}/repo/.git/config`],
    });

    await expect(
      scrubTargetsViaExec(exec, "sb_1", targets()),
    ).rejects.toBeInstanceOf(ScrubVerificationError);
  });
});

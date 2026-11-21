import { execFile } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SandboxFileTooLargeError } from "../provider";
import {
  ensureRigUserScript,
  rigCommandLine,
  RigFilePermissionError,
  rigUserOps,
  type VendorShell,
} from "./rig-user";

const run = promisify(execFile);

/**
 * A real bash with a fake `sudo` first on PATH: it drops sudo's options
 * and runs the rest as the current user. That runs every script this
 * module builds, quoting and pipes included, with no root.
 */
let dir: string;
let shell: VendorShell;
const scripts: string[] = [];

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "rig-user-"));
  const bin = join(dir, "bin");
  await mkdir(bin);
  await writeFile(
    join(bin, "sudo"),
    [
      "#!/usr/bin/env bash",
      "while [ $# -gt 0 ]; do",
      '  case "$1" in -n|-H) shift ;; -u) shift 2 ;; *) break ;; esac',
      "done",
      'exec "$@"',
      "",
    ].join("\n"),
  );
  await chmod(join(bin, "sudo"), 0o755);
  await mkdir(join(dir, "staging"));
  shell = {
    stagingDir: join(dir, "staging"),
    stage: (path, content) => writeFile(path, content),
    run: async (script) => {
      scripts.push(script);
      try {
        const { stdout, stderr } = await run("bash", ["-c", script], {
          env: { PATH: `${bin}:${process.env.PATH}`, HOME: dir },
        });
        return { exitCode: 0, stdout, stderr };
      } catch (error) {
        const e = error as { code: number; stdout: string; stderr: string };
        return { exitCode: e.code, stdout: e.stdout, stderr: e.stderr };
      }
    },
  };
});

afterAll(() => rm(dir, { recursive: true, force: true }));

describe("rigUserOps over a real shell", () => {
  it("runs a command in cwd with env, keeping the streams apart", async () => {
    const ops = rigUserOps(shell);
    const result = await ops.exec(
      `echo "$GREETING $(pwd)"; echo oops >&2; exit 3`,
      {
        cwd: dir,
        env: { GREETING: "it's me" },
      },
    );
    expect(result).toEqual({
      exitCode: 3,
      stdout: `it's me ${dir}\n`,
      stderr: "oops\n",
    });
  });

  it("keeps a command's own exit code when it reads only part of stdin", async () => {
    const ops = rigUserOps(shell);
    const result = await ops.exec("head -c 1 >/dev/null; exit 0", {
      input: "x".repeat(512 * 1024),
    });
    expect(result.exitCode).toBe(0);
  });

  it("delivers stdin and removes the staged input", async () => {
    const ops = rigUserOps(shell);
    const result = await ops.exec("tr a-z A-Z", { input: "secret input" });
    expect(result.stdout).toBe("SECRET INPUT");
    expect(scripts.some((s) => s.includes("secret input"))).toBe(false);
    expect(await run("ls", ["-A", join(dir, "staging")])).toMatchObject({
      stdout: "",
    });
  });

  it("writes a file with its parents and reads it back", async () => {
    const ops = rigUserOps(shell);
    const path = join(dir, "a b", "c", "file.bin");
    const bytes = Buffer.from([0, 1, 2, 255, 10]);
    await ops.writeFile(path, bytes);
    expect(await readFile(path)).toEqual(bytes);
    expect(await ops.readFile(path)).toEqual(new Uint8Array(bytes));
  });

  it("keeps an existing file's mode on write", async () => {
    const ops = rigUserOps(shell);
    const path = join(dir, "private");
    await writeFile(path, "old");
    await chmod(path, 0o600);
    await ops.writeFile(path, "new");
    expect(await readFile(path, "utf8")).toBe("new");
    const { stdout } = await run("stat", ["-c", "%a", path]);
    expect(stdout.trim()).toBe("600");
  });

  it("reads a missing file as null and refuses an unreadable one", async () => {
    const ops = rigUserOps(shell);
    expect(await ops.readFile(join(dir, "nope"))).toBeNull();
    const locked = join(dir, "locked");
    await writeFile(locked, "x");
    await chmod(locked, 0o000);
    // Root reads anything, so the check means nothing when tests run as root.
    if (process.getuid?.() !== 0) {
      await expect(ops.readFile(locked)).rejects.toBeInstanceOf(
        RigFilePermissionError,
      );
    }
  });

  it("stops a capped read one byte past the cap", async () => {
    const ops = rigUserOps(shell);
    const path = join(dir, "big");
    await writeFile(path, "x".repeat(100));
    expect((await ops.readFile(path, { maxBytes: 100 }))?.byteLength).toBe(100);
    await expect(ops.readFile(path, { maxBytes: 99 })).rejects.toBeInstanceOf(
      SandboxFileTooLargeError,
    );
  });
});

describe("command lines", () => {
  it("runs as amika by default and as root with sudo", () => {
    expect(rigCommandLine("id")).toBe(
      `sudo -n -H -u amika env bash -lc 'cd -- "$HOME" && id'`,
    );
    expect(rigCommandLine("id", { sudo: true })).toBe(
      `sudo -n -H env bash -lc 'cd -- "$HOME" && id'`,
    );
  });

  it("refuses an env name the shell would parse", () => {
    expect(() => rigCommandLine("true", { env: { "A B": "1" } })).toThrow(
      /Invalid environment variable name/,
    );
  });

  it("makes amika with its home and a sudo rule", () => {
    const script = ensureRigUserScript();
    expect(script).toContain("--home-dir '/home/amika'");
    expect(script).toContain("/etc/sudoers.d/90-amika");
    expect(script).toMatch(/if ! id -u 'amika'/);
    // Command lines carry secrets, so sudo must not log them.
    expect(script).toContain("Defaults !syslog, !logfile");
    expect(script).toContain("visudo -cqf");
  });
});

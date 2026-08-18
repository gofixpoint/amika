import { describe, it, expect } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildDaytonaCommand,
  buildDaytonaSessionCommand,
  buildStreamSplitCommand,
  executeCommand,
} from "./commands";
import { fakeDaytonaSandbox } from "./test-support";

type DaytonaSandbox = Parameters<typeof executeCommand>[0];

describe("buildDaytonaCommand", () => {
  it("wraps a non-sudo command in its own bash -c", () => {
    // One quoted word, so the command can never interact with the syntax of
    // whatever script embeds it, and it runs under bash rather than the zsh
    // Daytona picks for the outer script.
    expect(buildDaytonaCommand("echo hi")).toBe("bash -c 'echo hi'");
    expect(buildDaytonaCommand("echo hi", { sudo: false })).toBe(
      "bash -c 'echo hi'",
    );
  });

  it("keeps a command that would break an embedding script inert", () => {
    // Quoted, these cannot swallow a closing paren or strand it after an `&`.
    expect(buildDaytonaCommand("echo hi # note")).toBe(
      "bash -c 'echo hi # note'",
    );
    expect(buildDaytonaCommand("sleep 1 &")).toBe("bash -c 'sleep 1 &'");
  });

  it("quotes a sudo command containing single quotes", () => {
    expect(buildDaytonaCommand("git config x 'a b'", { sudo: true })).toContain(
      `bash -c 'git config x '"'"'a b'"'"''`,
    );
  });

  it("wraps a sudo command in a root bash -c so a compound command runs fully elevated", () => {
    // A bare `sudo touch a && touch b` would elevate only the first `touch`;
    // the whole command must be the `bash -c` argument.
    const cmd = buildDaytonaCommand("touch /root/a && touch /root/b", {
      sudo: true,
    });
    expect(cmd.startsWith("sudo -n")).toBe(true);
    expect(cmd).toContain("bash -c 'touch /root/a && touch /root/b'");
  });

  it("preserves the caller's env keys across the sudo boundary (plus the Amika hook vars)", () => {
    const cmd = buildDaytonaCommand("printenv FOO", {
      sudo: true,
      env: { FOO: "bar" },
    });
    expect(cmd).toContain(
      "--preserve-env=AMIKA_AGENT_CWD,AMIKA_OPENCODE_WEB,OPENCODE_SERVER_PASSWORD,FOO",
    );
  });

  it("rejects an env name that is not shell-legal", () => {
    // The name lands unquoted in `--preserve-env=`, so a `;` in it would end
    // the sudo command and start a new one. Checked here, not only in the
    // session builder, because the no-stdin path never reaches that one.
    expect(() =>
      buildDaytonaCommand("true", {
        sudo: true,
        env: { "FOO;touch /tmp/pwned": "x" },
      }),
    ).toThrow(/Invalid environment variable name/u);
  });
});

describe("buildDaytonaSessionCommand", () => {
  it("applies cwd and env in the outer shell, before sudo", () => {
    // Sessions take no cwd/env parameters, so both must be emitted into the
    // command string, and env must be exported *before* sudo, or
    // `--preserve-env` has nothing to preserve.
    const cmd = buildDaytonaSessionCommand("printenv FOO", {
      cwd: "/home/amika",
      env: { FOO: "bar" },
      sudo: true,
    });
    expect(
      cmd.startsWith("cd '/home/amika' && export FOO='bar' && sudo -n"),
    ).toBe(true);
  });

  it("applies cwd and env on the non-sudo path", () => {
    expect(
      buildDaytonaSessionCommand("printenv FOO", {
        cwd: "/home/amika",
        env: { FOO: "bar" },
      }),
    ).toBe("cd '/home/amika' && export FOO='bar' && bash -c 'printenv FOO'");
  });

  it("emits no setup prefix when there is nothing to set up", () => {
    expect(buildDaytonaSessionCommand("printenv FOO")).toBe(
      "bash -c 'printenv FOO'",
    );
  });

  it.skipIf(process.platform === "win32")(
    "aborts a multi-line command when the setup fails",
    () => {
      // `&&` is only safe here because the command is one `bash -c` word. Were
      // it inlined, the `&&` would bind to its first line and the tail would
      // run after a failed `cd` — in the wrong directory, reporting success.
      const cmd = buildDaytonaSessionCommand("echo one\necho two", {
        cwd: "/nonexistent",
      });
      const r = spawnSync("sh", { input: cmd, encoding: "utf8" });
      expect(r.status).not.toBe(0);
      expect(r.stdout).not.toContain("one");
      expect(r.stdout).not.toContain("two");
    },
  );

  it.skipIf(process.platform === "win32")(
    "applies cwd and env to every line of a multi-line command",
    () => {
      const cmd = buildDaytonaSessionCommand(
        'echo "1 $FOO $(pwd)"\necho "2 $FOO $(pwd)"',
        { cwd: "/tmp", env: { FOO: "bar" } },
      );
      const r = spawnSync("sh", { input: cmd, encoding: "utf8" });
      expect(r.status).toBe(0);
      expect(r.stdout).toBe("1 bar /tmp\n2 bar /tmp\n");
    },
  );

  it("rejects an environment variable name that is not shell-legal", () => {
    // The name is interpolated into an `export`, so it can't be trusted.
    expect(() =>
      buildDaytonaSessionCommand("true", { env: { "A; rm -rf /": "x" } }),
    ).toThrow(/Invalid environment variable name/u);
  });
});

describe("buildStreamSplitCommand", () => {
  it("routes the wrapper's own stderr into the capture file too", () => {
    // Capturing only the command's stderr leaves the wrapper's diagnostics — a
    // `Terminated` on a group kill, an OOM notice — in the response ahead of
    // the marker, i.e. reported as stdout.
    const script = buildStreamSplitCommand("bash -c 'true'", "M");
    expect(script).toContain('exec 2>"$__amika_err"');
    expect(script.indexOf("exec 2>")).toBeLessThan(
      script.indexOf("bash -c 'true'"),
    );
  });

  it("re-raises the command's own exit status after emitting the streams", () => {
    // The wrapper must be invisible to the caller: `mktemp`, `printf` and `cat`
    // all succeed, so without this the exit code would always be 0.
    const script = buildStreamSplitCommand("false", "M");
    expect(script).toContain("__amika_rc=$?");
    expect(script.trimEnd().endsWith('exit "$__amika_rc"')).toBe(true);
  });

  it("cleans up on a signal by exiting, not by falling through", () => {
    // A POSIX trap handler resumes where the shell was, so a handler that fell
    // through would report the command's own status for a wrapper that was told
    // to stop.
    const script = buildStreamSplitCommand("true", "M");
    for (const [signal, code] of [
      ["INT", 130],
      ["TERM", 143],
      ["HUP", 129],
    ] as const) {
      expect(script).toContain(`trap '__amika_bail ${code}' ${signal}`);
    }
    // Bailing must still emit both streams. Exiting bare would leave no marker,
    // so the whole of stdout would come back reported as failure text — and it
    // must emit at most once, or a signal landing mid-emit yields two markers.
    expect(script).toContain(
      '__amika_bail() { if [ -z "$__amika_emitted" ]; then __amika_emit; fi;',
    );
    expect(script).toContain("__amika_emit() { __amika_emitted=1;");
  });

  it("unlinks the capture before running the command, and fails closed", () => {
    // The security property: no path resolves to the captured stderr while the
    // command runs, so an untrappable kill can leave nothing behind.
    const script = buildStreamSplitCommand("true", "M");
    expect(script).toContain('rm -f -- "$__amika_err" || exit 125');
    expect(script.indexOf('rm -f -- "$__amika_err" || exit 125')).toBeLessThan(
      script.indexOf("( true )"),
    );
    // Redirected while the name still resolves, since that is the only moment it
    // can be opened at all.
    expect(script.indexOf('exec 2>"$__amika_err"')).toBeLessThan(
      script.indexOf('rm -f -- "$__amika_err" || exit 125'),
    );
    // Bash treats a failed redirection on a bare `exec` as non-fatal, so without
    // this it would run the command and emit its marker with no usable capture,
    // reporting a clean success carrying no stderr. Asserted structurally rather
    // than executed: redirecting fd 2 onto a descriptor that already exists, over
    // a file `mktemp` just created, has no reachable failure to drive from a test.
    expect(script).toContain('exec 2>"$__amika_err" || exit 125');
    // Nothing may read it by path afterwards — that is what the unlink breaks.
    expect(script).not.toContain('cat -- "$__amika_err"');
    expect(script).toContain("cat /proc/self/fd/2");
    // No second descriptor: one would need a free high fd and would be inherited
    // by every process the command leaves running.
    expect(script).not.toContain("9<");
  });

  it("arms cleanup for the window where the capture still has a name", () => {
    // dash and `sh` treat a redirection error on `exec` as fatal and kill the
    // script before any `||` branch runs, so the guard alone cannot clean up.
    // The trap has to be armed before that `exec` to cover it.
    const script = buildStreamSplitCommand("true", "M");
    expect(script).toContain(`trap 'rm -f -- "$__amika_err"' EXIT`);
    expect(script.indexOf("trap 'rm -f")).toBeLessThan(
      script.indexOf('exec 2>"$__amika_err"'),
    );
    // And it is armed only after there is something to remove.
    expect(script.indexOf("__amika_err=$(mktemp)")).toBeLessThan(
      script.indexOf("trap 'rm -f"),
    );
  });

  it("guards the capture path against being read as flags", () => {
    // `mktemp` honors TMPDIR, so a value starting with `-` would otherwise make
    // `rm` parse the path as an option bundle.
    expect(buildStreamSplitCommand("true", "M")).toContain(
      'rm -f -- "$__amika_err"',
    );
  });
});

// Asserting the generated text only proves it was generated. These run it, so
// they fail if the shell disagrees with what the string appears to say.
//
// Linux-only, not just non-Windows: the script calls bare `mktemp`, which BSD
// (macOS) `mktemp` rejects without a template, so every case here would take
// the `exit 125` guard path on a Mac. The sandboxes this runs against are
// Linux, so the script itself is fine — it is the assertions that don't
// travel.
describe.skipIf(process.platform !== "linux")(
  "buildStreamSplitCommand (executed)",
  () => {
    const run = (script: string, env: NodeJS.ProcessEnv = {}) =>
      spawnSync("sh", {
        input: script,
        encoding: "utf8",
        env: { ...process.env, ...env },
      });

    it("splits the two streams at the marker", () => {
      const r = run(buildStreamSplitCommand("echo out; echo err >&2", "--M--"));
      expect(r.status).toBe(0);
      const [stdout, stderr] = r.stdout.split("--M--");
      expect(stdout).toBe("out\n");
      expect(stderr).toBe("err\n");
    });

    it("does not run the command at all when the capture file can't be made", () => {
      // The bug the guard exists for: without it the failed `2>""` redirect
      // skips the subshell while the marker is still printed, so the split
      // succeeds and shell diagnostics arrive looking like command output.
      const r = run(buildStreamSplitCommand("echo SHOULD_NOT_RUN", "--M--"), {
        TMPDIR: "/nonexistent-dir-for-this-test",
      });
      // 125 specifically, so a shell dying for an unrelated reason can't pass.
      expect(r.status).toBe(125);
      expect(r.stdout).not.toContain("SHOULD_NOT_RUN");
      // No marker, so `splitStreamsAtMarker` reports it as failure text rather
      // than handing a parser the diagnostic as a value.
      expect(r.stdout).not.toContain("--M--");
    });

    it("re-raises the command's own exit status", () => {
      const r = run(buildStreamSplitCommand("exit 42", "--M--"));
      expect(r.status).toBe(42);
    });

    it("preserves both streams when the wrapper is signalled", async () => {
      // The gap that let a regression through: nothing exercised the signal
      // traps at runtime. Bailing without emitting would leave no marker, so
      // `splitStreamsAtMarker` would report the whole of stdout as failure
      // text and the real stderr would be lost entirely.
      //
      // POSIX defers a trap until the foreground command finishes, so the
      // sleep bounds the test's runtime — the signal is handled after it, not
      // during it.
      const script = buildStreamSplitCommand(
        "echo out; echo err >&2; sleep 2",
        "--M--",
      );
      const child = spawn("sh", { stdio: ["pipe", "pipe", "ignore"] });
      let out = "";
      child.stdout.setEncoding("utf8");
      const done = new Promise<number | null>((resolve) => {
        child.on("close", (code) => resolve(code));
      });
      // Kill only once the command has actually produced output, so the test
      // does not race the shell's startup.
      const sawOutput = new Promise<void>((resolve) => {
        child.stdout.on("data", (chunk: string) => {
          out += chunk;
          if (out.includes("out")) resolve();
        });
      });
      let code: number | null;
      try {
        child.stdin.end(script);
        await sawOutput;
        child.kill("SIGTERM");
        code = await done;
      } finally {
        // Bounded anyway by the `sleep`, but don't strand a shell if an
        // assertion or a stalled read gets here first.
        child.kill("SIGKILL");
      }

      expect(code).toBe(143);
      // Exactly one marker: a signal arriving mid-emit must not make the
      // handler emit a second one on top of the normal path's.
      expect(out.split("--M--")).toHaveLength(2);
      const [stdout, stderr] = out.split("--M--");
      expect(stdout).toBe("out\n");
      expect(stderr).toBe("err\n");
    }, 20_000);

    it("leaves nothing on disk even when killed untrappably", async () => {
      // The regression this guards. Cleanup used to be an `EXIT` trap, which a
      // `SIGKILL` never runs, so the capture file survived with the command's
      // stderr in it — and stderr carries secrets (a failed tokenized `git
      // clone` prints its URL there). A snapshot taken afterwards bakes that in
      // and is forkable. Unlinking up front means there is no name to leave.
      const dir = mkdtempSync(join(tmpdir(), "amika-kill-"));
      try {
        const script = buildStreamSplitCommand(
          buildDaytonaCommand("echo SECRET_TOKEN_abc123 >&2; sleep 10"),
          "--M--",
        );
        // TMPDIR must reach `mktemp` as an *environment* variable: it is a child
        // process, so an unexported shell assignment inside the script would be
        // invisible to it and this test would watch an empty directory and pass
        // no matter what the wrapper did.
        const child = spawn("sh", {
          stdio: ["pipe", "ignore", "ignore"],
          env: { ...process.env, TMPDIR: dir },
        });
        child.stdin.end(script);
        const exited = new Promise<void>((resolve) => {
          child.on("close", () => resolve());
        });
        // Let the wrapper get past its `mktemp`/unlink and into the command.
        await new Promise((resolve) => setTimeout(resolve, 1500));
        // Unlinked while the command is still running, so nothing is visible
        // even mid-flight — not merely cleaned up afterwards.
        expect(readdirSync(dir)).toEqual([]);
        child.kill("SIGKILL");
        await exited;

        expect(readdirSync(dir)).toEqual([]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }, 20_000);

    it("does not leak the capture handle to a process the command leaves running", async () => {
      // This path exists to leave daemons running, so any descriptor the wrapper
      // holds open is inherited and kept for the daemon's whole life — pinning the
      // unlinked inode, its bytes unreclaimable. An earlier revision opened a
      // second handle on fd 9 for reading the capture back, and redirecting was no
      // defense against it: that replaces fd 1 and 2 and never touches fd 9, so
      // even this well-behaved daemon held it. Reading via `/proc/self/fd/2`
      // needs no such handle; this pins that none comes back.
      const dir = mkdtempSync(join(tmpdir(), "amika-fd-"));
      // Unique per run, so a concurrent job on the same machine can't be found
      // instead of this test's own daemon.
      const tag = `sleep 9${100000 + (process.pid % 100000)}`;
      try {
        const script = buildStreamSplitCommand(
          // Redirects both its own streams, so any deleted-inode handle it holds
          // came from the wrapper rather than from its own stderr.
          buildDaytonaCommand(`nohup ${tag} >/dev/null 2>&1 &`),
          "--M--",
        );
        spawnSync("sh", {
          input: script,
          encoding: "utf8",
          env: { ...process.env, TMPDIR: dir },
        });

        // Find the daemon by its exact argv rather than a pattern match, so the
        // asking process can't be mistaken for it. Polled rather than read once:
        // the wrapper exits as soon as it has forked, so a single scan races the
        // child becoming visible in /proc — which is exactly how this test first
        // failed in CI while passing locally.
        const findDaemon = (): string | undefined =>
          readdirSync("/proc")
            .filter((name) => /^\d+$/u.test(name))
            .find((pid) => {
              try {
                const argv = readFileSync(`/proc/${pid}/cmdline`, "utf8");
                return argv.replace(/\0/gu, " ").trim() === tag;
              } catch {
                return false;
              }
            });
        let daemon = findDaemon();
        const deadline = Date.now() + 10_000;
        while (!daemon && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 50));
          daemon = findDaemon();
        }
        expect(daemon).toBeDefined();

        try {
          const fds = readdirSync(`/proc/${daemon!}/fd`).map((fd) => {
            try {
              return readlinkSync(`/proc/${daemon!}/fd/${fd}`);
            } catch {
              return "";
            }
          });
          expect(fds.filter((target) => target.includes("(deleted)"))).toEqual(
            [],
          );
        } finally {
          try {
            process.kill(Number(daemon), "SIGKILL");
          } catch {
            // Already gone; nothing to clean up.
          }
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }, 20_000);

    it("leaves no capture behind under descriptor exhaustion, on any shell", () => {
      // The invariant is residue, not a particular exit status: under a tight
      // `RLIMIT_NOFILE` some shells complete normally, bash bails via the `||`
      // guard, and dash and `sh` die on the `exec` before any branch can run.
      // Whichever happens, nothing may be left with a name — that last case is
      // why the cleanup is a trap and not only a `||` branch.
      //
      // Each shell is checked, because the failure is shell-specific and an
      // earlier version of this test watched only bash. Three runs each, since a
      // single leak is easy to miss but accumulation is not.
      const shells = ["bash", "dash", "sh", "zsh"];
      for (const shell of shells) {
        if (spawnSync("sh", ["-c", `command -v ${shell}`]).status !== 0)
          continue;
        const dir = mkdtempSync(join(tmpdir(), "amika-nofile-"));
        try {
          // Script kept outside TMPDIR, so the assertion sees only residue.
          const scriptPath = join(tmpdir(), `amika-wrapper-${process.pid}.sh`);
          writeFileSync(
            scriptPath,
            buildStreamSplitCommand(
              buildDaytonaCommand("echo OUT; echo IMPORTANT_STDERR >&2"),
              "--M--",
            ),
          );
          try {
            for (let run = 0; run < 3; run += 1) {
              spawnSync(
                "sh",
                ["-c", `ulimit -n 9; exec ${shell} "$1"`, "_", scriptPath],
                { encoding: "utf8", env: { ...process.env, TMPDIR: dir } },
              );
            }
            expect({ shell, residue: readdirSync(dir) }).toEqual({
              shell,
              residue: [],
            });
          } finally {
            rmSync(scriptPath, { force: true });
          }
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      }
    });

    it("leaves no capture file behind", () => {
      const dir = mkdtempSync(join(tmpdir(), "amika-split-"));
      try {
        const r = run(
          buildStreamSplitCommand("echo hi; echo bye >&2", "--M--"),
          {
            TMPDIR: dir,
          },
        );
        expect(r.status).toBe(0);
        expect(readdirSync(dir)).toEqual([]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  },
);

describe("executeCommand", () => {
  it("opens no session for an ordinary command, so what it backgrounds survives", async () => {
    // The regression this guards: Daytona owns a session's processes and kills
    // them when the session is deleted, `nohup`/`setsid` included, so a command
    // run that way loses the daemon it was meant to leave behind.
    const { sandbox, openSessions, commands } = fakeDaytonaSandbox();

    await executeCommand(
      sandbox as DaytonaSandbox,
      "nohup my-daemon >/var/log/my-daemon.log 2>&1 &",
    );

    expect(openSessions.size).toBe(0);
    expect(commands).toHaveLength(1);
    expect(commands[0]!.command).toContain("nohup my-daemon");
  });

  it("keeps stderr out of stdout on a successful command", async () => {
    // The regression the split guards: `sudo` writes "unable to resolve host …"
    // to stderr on images whose hostname doesn't resolve. Merging that into the
    // value stream broke every stdout parser, `amikad host-key show` first.
    const { sandbox } = fakeDaytonaSandbox(() => ({
      exitCode: 0,
      stdout: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5\n",
      stderr: "sudo: unable to resolve host sandbox\n",
    }));

    const result = await executeCommand(
      sandbox as DaytonaSandbox,
      "amikad host-key show",
      { sudo: true },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("ssh-ed25519 AAAAC3NzaC1lZDI1NTE5\n");
    expect(result.stdout).not.toContain("unable to resolve host");
    expect(result.stderr).toBe("sudo: unable to resolve host sandbox\n");
  });

  it("passes cwd and env to the one-shot API rather than into the command", async () => {
    // Unlike a session, `executeCommand` takes both as parameters, so `sudo`
    // inherits the env and `--preserve-env` has something to preserve.
    const { sandbox, commands } = fakeDaytonaSandbox();

    await executeCommand(sandbox as DaytonaSandbox, "printenv FOO", {
      cwd: "/home/amika",
      env: { FOO: "bar" },
    });

    expect(commands[0]!.cwd).toBe("/home/amika");
    expect(commands[0]!.env).toEqual({ FOO: "bar" });
    expect(commands[0]!.command).not.toContain("export FOO");
  });

  it("refuses a shell-illegal env name instead of running the command", async () => {
    // The no-stdin path skips the session builder that used to be the only
    // place this was checked, so assert it at the exec boundary itself: the
    // command must not reach the sandbox at all.
    const { sandbox, commands } = fakeDaytonaSandbox();

    await expect(
      executeCommand(sandbox as DaytonaSandbox, "true", {
        sudo: true,
        env: { "FOO;touch /tmp/pwned": "x" },
      }),
    ).rejects.toThrow(/Invalid environment variable name/u);
    expect(commands).toHaveLength(0);
  });

  it("reports a failure whose output never reached the marker as stderr", async () => {
    // The shell died before the wrapper's `printf`, so the response is a
    // diagnostic, not a value — it has to reach `execFailureText`, and must not
    // be handed to a stdout parser.
    const sandbox = {
      process: {
        executeCommand: () =>
          Promise.resolve({ exitCode: 127, result: "sh: no such file" }),
      },
    };

    const result = await executeCommand(
      sandbox as unknown as DaytonaSandbox,
      "nope",
    );

    expect(result.exitCode).toBe(127);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("sh: no such file");
  });

  it("pipes input to the command and closes stdin at the exact byte count", async () => {
    const { sandbox, commands } = fakeDaytonaSandbox();

    await executeCommand(
      sandbox as DaytonaSandbox,
      "amikad authorized-keys set",
      {
        input: "ssh-ed25519 AAAA\n",
      },
    );

    expect(commands).toHaveLength(1);
    expect(commands[0]!.command).toContain("head -c 17 | (");
    expect(commands[0]!.input).toBe("ssh-ed25519 AAAA\n");
  });

  it("runs a stdin command in a subshell so its shell state can't escape", async () => {
    // This is the only path left that touches a session, and a session is a
    // long-lived shell: bare text would run `set -e` in *that* shell, which
    // exits before the agent records an exit code and hangs the caller on a
    // result that never comes. The parens are what prevent it.
    const { sandbox, commands } = fakeDaytonaSandbox();

    await executeCommand(sandbox as DaytonaSandbox, "set -e\ngit fetch", {
      input: "x",
    });

    expect(commands[0]!.command).toBe(
      "head -c 1 | (bash -c 'set -e\ngit fetch')",
    );
  });

  it("treats empty input as no stdin wiring", async () => {
    const { sandbox, commands, openSessions } = fakeDaytonaSandbox();

    await executeCommand(sandbox as DaytonaSandbox, "true", { input: "" });

    expect(commands[0]!.command).not.toContain("head -c");
    expect(commands[0]!.input).toBeUndefined();
    expect(openSessions.size).toBe(0);
  });

  it("deletes the stdin path's session even when the command fails", async () => {
    const { sandbox, openSessions } = fakeDaytonaSandbox(() => ({
      exitCode: 1,
      stderr: "boom",
    }));

    const result = await executeCommand(sandbox as DaytonaSandbox, "false", {
      input: "x",
    });

    expect(result.exitCode).toBe(1);
    expect(openSessions.size).toBe(0);
  });
});

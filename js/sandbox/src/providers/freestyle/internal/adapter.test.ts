import { describe, expect, it, vi } from "vitest";
import { shellQuote } from "../../../util/shell";
import { buildFreestyleCommand, FreestyleAdapter } from "./adapter";

/**
 * Minimal stand-in for a Freestyle `Vm` handle. `user()` returns a separate
 * fake so a test can assert which handle (root vs. amika-scoped) ran a command.
 */
function fakeVm(execImpl: (opts: { command: string }) => unknown) {
  const exec = vi.fn(execImpl);
  const userVm = {
    exec: vi.fn(execImpl),
    fs: { readTextFile: vi.fn(), writeTextFile: vi.fn(), writeFile: vi.fn() },
  };
  const rootVm = {
    exec,
    user: vi.fn(() => userVm),
    fs: { readTextFile: vi.fn(), writeTextFile: vi.fn(), writeFile: vi.fn() },
  };
  return { rootVm, userVm };
}

// Every command is prefixed with a guarded source of the Amika-managed
// environment (see `buildFreestyleCommand`), so expectations include it.
const ENV =
  "[ -f /etc/environment ] && { set -a; . /etc/environment; set +a; }";

describe("buildFreestyleCommand", () => {
  it("sources the managed env before a bare command", () => {
    expect(buildFreestyleCommand("ls -la")).toBe(`${ENV}\nls -la`);
  });

  it("prefixes a cd for cwd", () => {
    expect(buildFreestyleCommand("ls", { cwd: "/home/amika/workspace" })).toBe(
      `${ENV}\ncd ${shellQuote("/home/amika/workspace")} || exit 1\nls`,
    );
  });

  it("exports env vars before the command", () => {
    const result = buildFreestyleCommand("printenv FOO", {
      env: { FOO: "bar", BAZ: "qux" },
    });
    expect(result).toBe(
      `${ENV}\nexport FOO=${shellQuote("bar")}\nexport BAZ=${shellQuote("qux")}\nprintenv FOO`,
    );
  });

  it("orders env source, then exports, then cd, then command", () => {
    const result = buildFreestyleCommand("run", {
      env: { A: "1" },
      cwd: "/work",
    });
    expect(result).toBe(
      `${ENV}\nexport A=${shellQuote("1")}\ncd ${shellQuote("/work")} || exit 1\nrun`,
    );
  });

  it("shell-quotes values containing special characters", () => {
    const tricky = "a'b c$d";
    const result = buildFreestyleCommand("echo", { env: { X: tricky } });
    expect(result).toBe(`${ENV}\nexport X=${shellQuote(tricky)}\necho`);
  });

  it("does not reflect the sudo flag in the command (handle selection does)", () => {
    // `sudo: true` selects the root VM handle in `FreestyleAdapter.exec`; the
    // command string itself is unchanged.
    expect(buildFreestyleCommand("whoami", { sudo: true })).toBe(
      `${ENV}\nwhoami`,
    );
  });
});

describe("FreestyleAdapter handle selection", () => {
  it("scopes a user handle to amika at construction", () => {
    const { rootVm } = fakeVm(() => ({ stdout: "", statusCode: 0 }));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    new FreestyleAdapter(rootVm as any);
    expect(rootVm.user).toHaveBeenCalledWith({ username: "amika" });
  });

  it("runs ordinary execs as amika and sudo execs as root", async () => {
    const { rootVm, userVm } = fakeVm(() => ({ stdout: "", statusCode: 0 }));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adapter = new FreestyleAdapter(rootVm as any);

    await adapter.exec("whoami");
    expect(userVm.exec).toHaveBeenCalledTimes(1);

    await adapter.exec("install -m 0755 a b", { sudo: true });
    // The sudo exec routes to root; the amika handle is untouched by it.
    expect(rootVm.exec).toHaveBeenCalledTimes(1);
    expect(userVm.exec).toHaveBeenCalledTimes(1);
  });

  it("writes uploads via the amika handle then chowns them to amika", async () => {
    // Freestyle's `fs` write API runs as root regardless of the amika-scoped
    // handle, so each upload is reassigned to amika via the root handle.
    const { rootVm, userVm } = fakeVm(() => ({ stdout: "", statusCode: 0 }));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adapter = new FreestyleAdapter(rootVm as any);

    await adapter.uploadFile("creds", "/home/amika/.git-credentials");

    expect(userVm.fs.writeTextFile).toHaveBeenCalledWith(
      "/home/amika/.git-credentials",
      "creds",
    );
    // The chown runs as root (sudo handle) with the managed-env prefix.
    expect(rootVm.exec).toHaveBeenCalledWith({
      command: buildFreestyleCommand(
        `chown amika:amika ${shellQuote("/home/amika/.git-credentials")}`,
        { sudo: true },
      ),
    });
  });

  it("throws when the upload ownership repair fails", async () => {
    const { rootVm } = fakeVm(() => ({ stdout: "", statusCode: 1 }));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adapter = new FreestyleAdapter(rootVm as any);

    await expect(
      adapter.uploadFile("creds", "/home/amika/.git-credentials"),
    ).rejects.toThrow(/Failed to chown/);
  });
});

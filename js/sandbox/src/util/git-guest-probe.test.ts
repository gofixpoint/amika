import { afterEach, describe, expect, it, vi } from "vitest";
import * as childProcess from "node:child_process";
import { checkBranchExistsOnRemote } from "./git-clone";

// A future accidental host-side fallback must fail this suite without networking.
vi.mock("node:child_process", () => ({
  execFile: vi.fn(() => {
    throw new Error("Host subprocess forbidden");
  }),
  exec: vi.fn(() => {
    throw new Error("Host subprocess forbidden");
  }),
  spawn: vi.fn(() => {
    throw new Error("Host subprocess forbidden");
  }),
}));
afterEach(() => {
  expect(childProcess.execFile).not.toHaveBeenCalled();
  expect(childProcess.exec).not.toHaveBeenCalled();
  expect(childProcess.spawn).not.toHaveBeenCalled();
  vi.clearAllMocks();
});

describe("guest branch probe", () => {
  it.each([
    [{ exitCode: 0, stdout: "sha\trefs/heads/main\n" }, true],
    [{ exitCode: 0, stdout: "" }, false],
    [{ exitCode: 128, stdout: "" }, true],
  ] as const)(
    "interprets guest result %j without a host probe",
    async (result, expected) => {
      const executeInGuest = vi.fn(async () => result);
      await expect(
        checkBranchExistsOnRemote(
          executeInGuest,
          "ssh://git@customer.internal/org/repo.git",
          null,
          "main",
        ),
      ).resolves.toBe(expected);
      expect(executeInGuest).toHaveBeenCalledWith(
        "git 'ls-remote' '--heads' '--' 'ssh://git@customer.internal/org/repo.git' 'refs/heads/main'",
      );
    },
  );

  it("treats guest executor failure as unknown without local retry", async () => {
    const executeInGuest = vi.fn(async () => {
      throw new Error("Guest unavailable");
    });
    await expect(
      checkBranchExistsOnRemote(
        executeInGuest,
        "https://127.0.0.1/repo",
        null,
        "main",
      ),
    ).resolves.toBe(true);
    expect(executeInGuest).toHaveBeenCalledOnce();
  });

  it("quotes remote URL metacharacters and rejects invalid refs before execution", async () => {
    const executeInGuest = vi
      .fn<(command: string) => Promise<{ exitCode: number; stdout: string }>>()
      .mockResolvedValue({ exitCode: 0, stdout: "" });
    await checkBranchExistsOnRemote(
      executeInGuest,
      "https://git.example/x'y",
      null,
      "main",
    );
    expect(executeInGuest.mock.calls[0][0]).toContain(
      `'https://git.example/x'"'"'y'`,
    );
    executeInGuest.mockClear();
    await expect(
      checkBranchExistsOnRemote(
        executeInGuest,
        "https://git.example/repo",
        null,
        "main;id",
      ),
    ).rejects.toThrow();
    expect(executeInGuest).not.toHaveBeenCalled();
  });
});

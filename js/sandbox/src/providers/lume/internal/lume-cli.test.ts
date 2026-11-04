import { describe, expect, it } from "vitest";
import { LumeCli, LumeCliError } from "./lume-cli";
import type { ProcessResult, ProcessRunner } from "./process";

const VM = {
  name: "rig-1",
  status: "running",
  ipAddress: "192.168.64.7",
  cpuCount: 2,
  memorySize: 4 * 1024 ** 3,
  diskSize: { total: 80 * 1024 ** 3, allocated: 1 },
};

function cli(result: Partial<ProcessResult>) {
  const calls: string[][] = [];
  const runner: ProcessRunner = async (_bin, args) => {
    calls.push(args);
    return {
      exitCode: 0,
      stdout: Buffer.from(""),
      stderr: Buffer.from(""),
      ...result,
    };
  };
  return { calls, cli: new LumeCli("/vms", "lume", runner) };
}

describe("LumeCli", () => {
  it("reads a VM from its storage folder", async () => {
    const { cli: lume, calls } = cli({
      stdout: Buffer.from(JSON.stringify([VM])),
    });
    expect(await lume.get("rig-1")).toMatchObject({ status: "running" });
    expect(calls[0]).toContain("/vms");
  });

  it("reads a missing VM as null", async () => {
    const { cli: lume } = cli({
      exitCode: 1,
      stderr: Buffer.from(
        "Error: Virtual machine not found: rig-1\n[t] ERROR: Failed to get VM details\n",
      ),
    });
    expect(await lume.get("rig-1")).toBeNull();
  });

  it("throws Lume's reason for any other failure", async () => {
    const { cli: lume } = cli({
      exitCode: 1,
      stderr: Buffer.from("[t] INFO: Cloning\nError: VM already exists\n"),
    });
    await expect(lume.clone("tahoe", "rig-1")).rejects.toThrow(
      new LumeCliError("clone", 1, "VM already exists"),
    );
  });
});

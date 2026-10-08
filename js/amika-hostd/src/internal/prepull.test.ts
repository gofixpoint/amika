/** Cover pulling the preset images into smolvm's cache once. */
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  RuntimeError,
  type MachineInfo,
  type MachineRuntime,
} from "./machine-runtime.js";
import { pendingImages, prepullImages, pulledImages } from "./prepull.js";

const CODER = "ghcr.io/gofixpoint/amika-coder:latest";
const DOCKER = "ghcr.io/gofixpoint/amika-coder-plus-docker:latest";
const IMAGES = { "amika-coder": CODER, coder: CODER, "with-docker": DOCKER };

function stateFile(images?: string[]): string {
  const file = path.join(
    mkdtempSync(path.join(tmpdir(), "amika-hostd-")),
    "prepull.json",
  );
  if (images) writeFileSync(file, JSON.stringify({ images }));
  return file;
}

function machine(name: string): MachineInfo {
  return { name, state: "running", cpus: 1, memoryMb: 512, ports: [] };
}

/** A runtime whose machines exist only in memory. */
function fakeRuntime(machines: string[] = []) {
  const names = new Set(machines);
  const runtime = {
    list: vi.fn(async () => [...names].map(machine)),
    create: vi.fn(async ({ name }: { name: string }) => {
      names.add(name);
      return machine(name);
    }),
    remove: vi.fn(async (name: string) => {
      names.delete(name);
    }),
  };
  return {
    names,
    runtime,
    asRuntime: runtime as unknown as MachineRuntime,
  };
}

function run(
  runtime: MachineRuntime,
  file: string,
  options: { signal?: AbortSignal } = {},
) {
  const out: string[] = [];
  const err: string[] = [];
  let clock = 0;
  const done = prepullImages({
    images: IMAGES,
    stateFile: file,
    runtime,
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    now: () => (clock += 30_000),
    ...options,
  });
  return { done, out, err };
}

describe("pendingImages", () => {
  it("lists each configured reference once, with its presets", () => {
    expect(pendingImages(IMAGES, stateFile())).toEqual([
      { image: CODER, presets: ["amika-coder", "coder"] },
      { image: DOCKER, presets: ["with-docker"] },
    ]);
  });

  it("leaves out references already pulled", () => {
    expect(pendingImages(IMAGES, stateFile([CODER]))).toEqual([
      { image: DOCKER, presets: ["with-docker"] },
    ]);
  });

  it("treats an unreadable state file as nothing pulled", () => {
    const file = stateFile();
    writeFileSync(file, "not json");
    expect(pulledImages(file)).toEqual(new Set());
    expect(pendingImages(IMAGES, file)).toHaveLength(2);
  });
});

describe("prepullImages", () => {
  it("pulls each image through a throwaway machine, and records it", async () => {
    const { runtime, asRuntime, names } = fakeRuntime(["rig-1"]);
    const file = stateFile();
    const { done, out, err } = run(asRuntime, file);
    await done;
    expect(runtime.create.mock.calls.map(([request]) => request)).toEqual([
      {
        name: "amika-hostd-prepull-0",
        image: CODER,
        network: true,
        storageGb: 20,
      },
      {
        name: "amika-hostd-prepull-1",
        image: DOCKER,
        network: true,
        storageGb: 20,
      },
    ]);
    expect(runtime.remove.mock.calls).toEqual([
      ["amika-hostd-prepull-0"],
      ["amika-hostd-prepull-1"],
    ]);
    // One image at a time.
    expect(runtime.remove.mock.invocationCallOrder[0]).toBeLessThan(
      runtime.create.mock.invocationCallOrder[1],
    );
    expect([...names]).toEqual(["rig-1"]);
    expect(pulledImages(file)).toEqual(new Set([CODER, DOCKER]));
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(out).toEqual([
      `Pre-pulling ${CODER} (amika-coder, coder)`,
      `Pre-pulled ${CODER} in 30s; new rigs of it start from smolvm's image cache`,
      `Pre-pulling ${DOCKER} (with-docker)`,
      `Pre-pulled ${DOCKER} in 30s; new rigs of it start from smolvm's image cache`,
    ]);
    expect(err).toEqual([]);
  });

  it("pulls nothing already recorded", async () => {
    const { runtime, asRuntime } = fakeRuntime();
    await run(asRuntime, stateFile([CODER, DOCKER])).done;
    expect(runtime.create).not.toHaveBeenCalled();
  });

  it("deletes throwaway machines an earlier run left behind", async () => {
    const { runtime, asRuntime, names } = fakeRuntime([
      "amika-hostd-prepull-3",
      "rig-1",
    ]);
    await run(asRuntime, stateFile([CODER, DOCKER])).done;
    expect(runtime.remove).toHaveBeenCalledWith("amika-hostd-prepull-3");
    expect([...names]).toEqual(["rig-1"]);
  });

  it("leaves a failed pull unrecorded, cleans up, and goes on", async () => {
    const { runtime, asRuntime, names } = fakeRuntime();
    runtime.create.mockImplementationOnce(async ({ name }) => {
      names.add(name);
      throw new RuntimeError(504, "smolvm POST  timed out");
    });
    const file = stateFile();
    const { done, err } = run(asRuntime, file);
    await done;
    expect(err).toEqual([
      `amika-hostd: could not pre-pull ${CODER}: smolvm POST  timed out; rigs of it pull it themselves, and the next \`amika-hostd up\` tries again`,
    ]);
    expect(runtime.remove).toHaveBeenCalledWith("amika-hostd-prepull-0");
    expect(pulledImages(file)).toEqual(new Set([DOCKER]));
    expect(names.size).toBe(0);
  });

  it("never throws, even when smolvm cannot list or delete machines", async () => {
    const { runtime, asRuntime } = fakeRuntime();
    runtime.list.mockRejectedValue(new RuntimeError(502, "unreachable"));
    runtime.remove.mockRejectedValue(new RuntimeError(502, "unreachable"));
    const file = stateFile();
    const { done, err } = run(asRuntime, file);
    await expect(done).resolves.toBeUndefined();
    expect(err[0]).toBe(
      "amika-hostd: could not list machines before pre-pulling: unreachable",
    );
    // The image was pulled, so it is recorded even though its machine stayed.
    expect(pulledImages(file)).toEqual(new Set([CODER, DOCKER]));
  });

  it("stops before the next image once the daemon is stopping", async () => {
    const { runtime, asRuntime } = fakeRuntime();
    const stopping = new AbortController();
    runtime.create.mockImplementationOnce(async ({ name }) => {
      stopping.abort();
      return machine(name);
    });
    const file = stateFile();
    await run(asRuntime, file, { signal: stopping.signal }).done;
    expect(runtime.create).toHaveBeenCalledTimes(1);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ images: [CODER] });
  });
});

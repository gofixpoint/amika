/** Cover keeping the preset images in smolvm's cache. */
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { RuntimeError, type MachineInfo } from "./machine-runtime.js";
import {
  pendingImages,
  prepullImages,
  pulledImages,
  type PrepullOptions,
} from "./prepull.js";

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
    createUnstarted: vi.fn(async ({ name }: { name: string }) => {
      names.add(name);
    }),
    remove: vi.fn(async (name: string) => {
      names.delete(name);
    }),
  };
  return { names, runtime };
}

function run(
  runtime: PrepullOptions["runtime"],
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
  it("caches each image through an unstarted throwaway machine, and records it", async () => {
    const { runtime, names } = fakeRuntime(["rig-1"]);
    const file = stateFile();
    const { done, out, err } = run(runtime, file);
    await done;
    expect(
      runtime.createUnstarted.mock.calls.map(([request]) => request),
    ).toEqual([
      { name: "amika-hostd-prepull-0", image: CODER, storageGb: 20 },
      { name: "amika-hostd-prepull-1", image: DOCKER, storageGb: 20 },
    ]);
    expect(runtime.remove.mock.calls).toEqual([
      ["amika-hostd-prepull-0"],
      ["amika-hostd-prepull-1"],
    ]);
    // One image at a time.
    expect(runtime.remove.mock.invocationCallOrder[0]).toBeLessThan(
      runtime.createUnstarted.mock.invocationCallOrder[1],
    );
    expect([...names]).toEqual(["rig-1"]);
    expect(pulledImages(file)).toEqual(new Set([CODER, DOCKER]));
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(out).toEqual([
      `Checking that ${CODER} (amika-coder, coder) is cached`,
      `${CODER} is cached (30s); new rigs of it start from smolvm's image cache`,
      `Checking that ${DOCKER} (with-docker) is cached`,
      `${DOCKER} is cached (30s); new rigs of it start from smolvm's image cache`,
    ]);
    expect(err).toEqual([]);
  });

  it("checks images pulled before too, so smolvm refills an evicted one", async () => {
    const { runtime } = fakeRuntime();
    const file = stateFile([CODER, DOCKER]);
    await run(runtime, file).done;
    expect(runtime.createUnstarted).toHaveBeenCalledTimes(2);
    expect(pulledImages(file)).toEqual(new Set([CODER, DOCKER]));
  });

  it("deletes throwaway machines an earlier run left behind", async () => {
    const { runtime, names } = fakeRuntime(["amika-hostd-prepull-3", "rig-1"]);
    await run(runtime, stateFile([CODER, DOCKER])).done;
    expect(runtime.remove).toHaveBeenCalledWith("amika-hostd-prepull-3");
    expect([...names]).toEqual(["rig-1"]);
  });

  it("leaves a failed pull unrecorded, cleans up, and goes on", async () => {
    const { runtime, names } = fakeRuntime();
    runtime.createUnstarted.mockImplementationOnce(async ({ name }) => {
      names.add(name);
      throw new RuntimeError(504, "smolvm POST  timed out");
    });
    const file = stateFile();
    const { done, err } = run(runtime, file);
    await done;
    expect(err).toEqual([
      `amika-hostd: could not cache ${CODER}: smolvm POST  timed out; rigs of it may pull it themselves, and the next \`amika-hostd up\` tries again`,
    ]);
    expect(runtime.remove).toHaveBeenCalledWith("amika-hostd-prepull-0");
    expect(pulledImages(file)).toEqual(new Set([DOCKER]));
    expect(names.size).toBe(0);
  });

  it("never throws, even when smolvm cannot list or delete machines", async () => {
    const { runtime } = fakeRuntime();
    runtime.list.mockRejectedValue(new RuntimeError(502, "unreachable"));
    runtime.remove.mockRejectedValue(new RuntimeError(502, "unreachable"));
    const file = stateFile();
    const { done, err } = run(runtime, file);
    await expect(done).resolves.toBeUndefined();
    expect(err[0]).toBe(
      "amika-hostd: could not list machines before pre-pulling: unreachable",
    );
    // The image was pulled, so it is recorded even though its machine stayed.
    expect(pulledImages(file)).toEqual(new Set([CODER, DOCKER]));
  });

  it("stops before the next image once the daemon is stopping", async () => {
    const { runtime } = fakeRuntime();
    const stopping = new AbortController();
    runtime.createUnstarted.mockImplementationOnce(async () => {
      stopping.abort();
    });
    const file = stateFile();
    await run(runtime, file, { signal: stopping.signal }).done;
    expect(runtime.createUnstarted).toHaveBeenCalledTimes(1);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ images: [CODER] });
  });
});

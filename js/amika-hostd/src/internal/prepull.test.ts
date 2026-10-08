/** Cover keeping the preset images in smolvm's cache. */
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { RuntimeError } from "./machine-runtime.js";
import {
  pendingImages,
  prepullImages,
  prepullMachines,
  pulledImages,
  type PrepullOptions,
} from "./prepull.js";

const CODER = "ghcr.io/gofixpoint/amika-coder:latest";
const DOCKER = "ghcr.io/gofixpoint/amika-coder-plus-docker:latest";
const IMAGES = { "amika-coder": CODER, coder: CODER, "with-docker": DOCKER };

function stateFile(images?: string[], machines?: string[]): string {
  const file = path.join(
    mkdtempSync(path.join(tmpdir(), "amika-hostd-")),
    "prepull.json",
  );
  if (images) writeFileSync(file, JSON.stringify({ images, machines }));
  return file;
}

/** A runtime whose machines exist only in memory. */
function fakeRuntime(machines: string[] = []) {
  const names = new Set(machines);
  const runtime = {
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
  options: Partial<Pick<PrepullOptions, "signal" | "newSuffix" | "used">> = {},
) {
  const out: string[] = [];
  const err: string[] = [];
  let clock = 0;
  let suffix = 0;
  const done = prepullImages({
    images: IMAGES,
    stateFile: file,
    runtime,
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    now: () => (clock += 30_000),
    newSuffix: () => String(suffix++),
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
  it("caches each image through an unstarted throwaway machine", async () => {
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
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
      images: [CODER, DOCKER],
      machines: [],
    });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(out).toEqual([
      `Checking that ${CODER} (amika-coder, coder) is cached`,
      `Checked ${CODER} (30s); if its rigs still download it, see smolvm.log`,
      `Checking that ${DOCKER} (with-docker) is cached`,
      `Checked ${DOCKER} (30s); if its rigs still download it, see smolvm.log`,
    ]);
    expect(err).toEqual([]);
  });

  it("records each machine before creating it", async () => {
    const { runtime } = fakeRuntime();
    const file = stateFile();
    const recorded: Set<string>[] = [];
    runtime.createUnstarted.mockImplementation(async () => {
      recorded.push(prepullMachines(file));
    });
    await run(runtime, file).done;
    expect(recorded).toEqual([
      new Set(["amika-hostd-prepull-0"]),
      new Set(["amika-hostd-prepull-1"]),
    ]);
  });

  it("reports each name before creating it, and keeps it after deleting it", async () => {
    const { runtime } = fakeRuntime();
    const used = new Set<string>();
    const seen: Set<string>[] = [];
    runtime.createUnstarted.mockImplementation(async () => {
      seen.push(new Set(used));
    });
    await run(runtime, stateFile(), { used }).done;
    expect(seen).toEqual([
      new Set(["amika-hostd-prepull-0"]),
      new Set(["amika-hostd-prepull-0", "amika-hostd-prepull-1"]),
    ]);
    expect(used).toEqual(
      new Set(["amika-hostd-prepull-0", "amika-hostd-prepull-1"]),
    );
  });

  it("checks images pulled before too, so smolvm refills an evicted one", async () => {
    const { runtime } = fakeRuntime();
    const file = stateFile([CODER, DOCKER]);
    await run(runtime, file).done;
    expect(runtime.createUnstarted).toHaveBeenCalledTimes(2);
    expect(pulledImages(file)).toEqual(new Set([CODER, DOCKER]));
  });

  it("deletes only the machines an earlier run recorded, never a rig sharing the prefix", async () => {
    const { runtime, names } = fakeRuntime([
      "amika-hostd-prepull-old",
      "amika-hostd-prepull-3",
      "rig-1",
    ]);
    const file = stateFile([CODER, DOCKER], ["amika-hostd-prepull-3"]);
    await run(runtime, file).done;
    expect(runtime.remove).not.toHaveBeenCalledWith("amika-hostd-prepull-old");
    expect(runtime.remove).toHaveBeenCalledWith("amika-hostd-prepull-3");
    expect([...names].sort()).toEqual(["amika-hostd-prepull-old", "rig-1"]);
    expect(prepullMachines(file)).toEqual(new Set());
  });

  it("keeps a recorded machine it could not delete, to try again", async () => {
    const { runtime } = fakeRuntime(["amika-hostd-prepull-3"]);
    runtime.remove.mockRejectedValueOnce(new RuntimeError(502, "unreachable"));
    const file = stateFile([], ["amika-hostd-prepull-3"]);
    const { done, err } = run(runtime, file);
    await done;
    expect(err[0]).toBe(
      "amika-hostd: could not delete pre-pull machine amika-hostd-prepull-3: unreachable; the next `amika-hostd up` tries again",
    );
    expect(prepullMachines(file)).toEqual(new Set(["amika-hostd-prepull-3"]));
  });

  it("names each throwaway machine randomly, so it never takes another's name", async () => {
    const { runtime } = fakeRuntime();
    await prepullImages({
      images: IMAGES,
      stateFile: stateFile(),
      runtime,
      out: () => {},
      err: () => {},
    });
    const [first, second] = runtime.createUnstarted.mock.calls.map(
      ([{ name }]) => name,
    );
    expect(first).toMatch(/^amika-hostd-prepull-[0-9a-f]{16}$/);
    expect(second).toMatch(/^amika-hostd-prepull-[0-9a-f]{16}$/);
    expect(first).not.toBe(second);
  });

  it("forgets a recorded machine that is already gone", async () => {
    const { runtime } = fakeRuntime();
    runtime.remove.mockRejectedValueOnce(new RuntimeError(404, "not found"));
    const file = stateFile([], ["amika-hostd-prepull-3"]);
    const { done, err } = run(runtime, file);
    await done;
    expect(err).toEqual([]);
    expect(prepullMachines(file)).toEqual(new Set());
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

  it("never deletes a machine whose name another took first", async () => {
    const { runtime } = fakeRuntime();
    runtime.createUnstarted.mockRejectedValueOnce(
      new RuntimeError(409, "machine amika-hostd-prepull-0 already exists"),
    );
    const file = stateFile();
    await run(runtime, file).done;
    expect(runtime.remove).not.toHaveBeenCalledWith("amika-hostd-prepull-0");
    expect(
      runtime.createUnstarted.mock.calls.map(([{ name }]) => name),
    ).toEqual(["amika-hostd-prepull-0", "amika-hostd-prepull-1"]);
    expect(prepullMachines(file)).toEqual(new Set());
  });

  it("stops quietly once the daemon is stopping, leaving its machine recorded", async () => {
    const { runtime } = fakeRuntime();
    const stopping = new AbortController();
    runtime.createUnstarted.mockImplementationOnce(async () => {
      stopping.abort();
      throw new TypeError("fetch failed");
    });
    const file = stateFile();
    const { done, err } = run(runtime, file, { signal: stopping.signal });
    await done;
    expect(err).toEqual([]);
    expect(runtime.createUnstarted).toHaveBeenCalledTimes(1);
    expect(runtime.remove).not.toHaveBeenCalled();
    expect(prepullMachines(file)).toEqual(new Set(["amika-hostd-prepull-0"]));
  });
});

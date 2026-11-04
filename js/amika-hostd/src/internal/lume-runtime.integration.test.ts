/**
 * The Lume runtime against a real Lume VM. Skipped unless
 * `TEST_LUME_IMAGE` names a stopped image VM in Lume's default storage (one
 * that `macos-image/build.sh` made). Run on an Apple Silicon Mac:
 *
 *   TEST_LUME_IMAGE=<image> TEST_LUME_DIR=<an empty folder> \
 *   pnpm --filter @amika/hostd test src/internal/lume-runtime.integration
 *
 * One VM at a time; it takes about two minutes.
 */
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { lumeRuntime, type LumeRuntime } from "./lume-runtime.js";
import { RuntimeError } from "./machine-runtime.js";

const image = process.env.TEST_LUME_IMAGE;
const dir = process.env.TEST_LUME_DIR;

describe.skipIf(!image || !dir)("lumeRuntime on a real VM", () => {
  const name = `hostd-lume-${Date.now()}`;
  let runtime: LumeRuntime;

  beforeAll(async () => {
    runtime = lumeRuntime({
      storageDir: path.join(dir!, "vms"),
      stateDir: path.join(dir!, "state"),
    });
    const created = await runtime.create({
      name,
      image: image!,
      cpus: 2,
      memoryMb: 4096,
      network: true,
      services: [{ name: "web", port: 8000 }],
    });
    expect(created).toMatchObject({ name, state: "running", cpus: 2 });
  }, 300_000);
  afterAll(async () => {
    await runtime?.remove(name).catch(() => {});
    await runtime?.shutdown();
  }, 120_000);

  it("runs argv as amika, or as root, with stdin and the image's PATH", async () => {
    expect(
      await runtime.exec(name, {
        command: ["sh", "-c", 'echo "$1 $(id -un)"', "sh", "a b"],
      }),
    ).toMatchObject({ exitCode: 0, stdout: "a b amika\n" });
    expect(
      await runtime.exec(name, { command: ["id", "-un"], user: "root" }),
    ).toMatchObject({ stdout: "root\n" });
    expect(
      await runtime.exec(name, { command: ["cat"], stdin: "piped" }),
    ).toMatchObject({ stdout: "piped" });
    expect(
      await runtime.exec(name, { command: ["amikad", "--version"] }),
    ).toMatchObject({ exitCode: 0 });
  });

  it("writes and reads a file's exact bytes, and answers 404 for none", async () => {
    const bytes = new Uint8Array([0, 1, 2, 255]);
    await runtime.writeFile(name, "/Users/amika/hostd/bytes.bin", bytes);
    const file = await runtime.readFile(name, "/Users/amika/hostd/bytes.bin");
    expect(new Uint8Array(await new Response(file.body).arrayBuffer())).toEqual(
      bytes,
    );
    await expect(
      runtime.readFile(name, "/Users/amika/hostd/none"),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("forwards a service port from loopback to the guest, and never port 22", async () => {
    await runtime.exec(name, {
      command: [
        "sh",
        "-c",
        // One `&&` list put in the background would keep this session's
        // stdout, and so the exec, open.
        "mkdir -p /tmp/web && echo hello > /tmp/web/index.html; python3 -m http.server 8000 --directory /tmp/web </dev/null >/dev/null 2>&1 &",
      ],
    });
    const port = await runtime.hostPort(name, 8000);
    expect(port).toBeGreaterThan(0);
    let body = "";
    for (let i = 0; i < 30 && body === ""; i++) {
      body = await fetch(`http://127.0.0.1:${port}/`).then(
        (r) => r.text(),
        async () => {
          await new Promise((resolve) => setTimeout(resolve, 500));
          return "";
        },
      );
    }
    expect(body).toBe("hello\n");
    expect(await runtime.hostPort(name, 22)).toBeNull();
    expect((await runtime.get(name)).ports).toEqual([
      { guest: 8000, host: port },
    ]);
  }, 60_000);

  it("stops and starts, keeping the disk, and boots a stopped VM for exec", async () => {
    expect(await runtime.stop(name)).toMatchObject({ state: "stopped" });
    expect(await runtime.hostPort(name, 8000)).toBeNull();
    expect(
      await runtime.exec(name, {
        command: ["cat", "/Users/amika/hostd/bytes.bin"],
      }),
    ).toMatchObject({ exitCode: 0 });
    expect((await runtime.get(name)).state).toBe("running");
  }, 300_000);

  it("refuses a disk smaller than the image's", async () => {
    await expect(
      runtime.create({
        name: `${name}-small`,
        image: image!,
        cpus: 2,
        memoryMb: 4096,
        storageGb: 10,
        network: true,
      }),
    ).rejects.toBeInstanceOf(RuntimeError);
    await expect(runtime.get(`${name}-small`)).rejects.toMatchObject({
      status: 404,
    });
  });

  it("deletes the VM, and then does not find it", async () => {
    await runtime.remove(name);
    await expect(runtime.get(name)).rejects.toMatchObject({ status: 404 });
  }, 120_000);
});

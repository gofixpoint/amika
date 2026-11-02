/** Cover installing a bare-metal host's amikad from a fake release. */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { hostPlatformFor } from "../platforms/index.js";
import {
  AMIKAD_RELEASES_URL,
  DEFAULT_AMIKAD_VERSION,
  amikadBinary,
  amikadRelease,
  ensureAmikad,
  installedAmikadPath,
} from "./amikad-install.js";
import { ConfigError } from "./config.js";

const LINUX = hostPlatformFor("linux", { arch: () => "x64" });
const ARCHIVE = `amikad_${DEFAULT_AMIKAD_VERSION}_linux_amd64.tar.gz`;
const TAG_URL = `${AMIKAD_RELEASES_URL}/amikad@v${DEFAULT_AMIKAD_VERSION}`;

/** A release archive as the Release workflow builds one, and its checksums. */
function release(binary = "#!/bin/sh\necho amikad\n") {
  const dir = mkdtempSync(path.join(tmpdir(), "amikad-release-"));
  const base = ARCHIVE.replace(/\.tar\.gz$/, "");
  mkdirSync(path.join(dir, base));
  writeFileSync(path.join(dir, base, "amikad"), binary, { mode: 0o755 });
  execFileSync("tar", ["-czf", path.join(dir, ARCHIVE), "-C", dir, base]);
  const bytes = readFileSync(path.join(dir, ARCHIVE));
  const sum = createHash("sha256").update(bytes).digest("hex");
  return {
    bytes,
    checksums: `${"0".repeat(64)}  other.tar.gz\n${sum}  ${ARCHIVE}\n`,
  };
}

function serving(files: Record<string, Buffer | string>) {
  return vi.fn<typeof fetch>(async (input) => {
    const body = files[String(input)];
    return body === undefined
      ? new Response("missing", { status: 404 })
      : new Response(body);
  });
}

function harness(files: Record<string, Buffer | string>) {
  const home = mkdtempSync(path.join(tmpdir(), "amika-hostd-home-"));
  const out: string[] = [];
  const fetcher = serving(files);
  return {
    env: { AMIKA_HOSTD_HOME: home },
    out,
    fetcher,
    deps: {
      env: { AMIKA_HOSTD_HOME: home },
      platform: LINUX,
      out: (line: string) => out.push(line),
      fetch: fetcher,
    },
  };
}

describe("amikadRelease", () => {
  it("names the release asset as the Release workflow does", () => {
    expect(amikadRelease("0.3.0", LINUX)).toEqual({
      archive: "amikad_0.3.0_linux_amd64.tar.gz",
      archiveUrl:
        "https://github.com/gofixpoint/amika/releases/download/amikad@v0.3.0/amikad_0.3.0_linux_amd64.tar.gz",
      checksumsUrl:
        "https://github.com/gofixpoint/amika/releases/download/amikad@v0.3.0/checksums.txt",
    });
    expect(
      amikadRelease("0.3.0", hostPlatformFor("darwin", { arch: () => "arm64" }))
        .archive,
    ).toBe("amikad_0.3.0_darwin_arm64.tar.gz");
  });

  it("refuses a machine amikad is not released for", () => {
    expect(() => amikadRelease("0.3.0", hostPlatformFor("win32"))).toThrow(
      ConfigError,
    );
  });
});

describe("ensureAmikad", () => {
  it("installs the verified release into hostd's data directory", async () => {
    const { bytes, checksums } = release();
    const h = harness({
      [`${TAG_URL}/${ARCHIVE}`]: bytes,
      [`${TAG_URL}/checksums.txt`]: checksums,
    });
    const installed = await ensureAmikad({}, h.deps);
    expect(installed).toBe(
      path.join(
        h.env.AMIKA_HOSTD_HOME,
        "amikad",
        DEFAULT_AMIKAD_VERSION,
        "amikad",
      ),
    );
    expect(installed).toBe(installedAmikadPath(h.env));
    expect(execFileSync(installed, { encoding: "utf8" })).toBe("amikad\n");
    expect(statSync(installed).mode & 0o777).toBe(0o755);
    expect(h.out.at(-1)).toBe(
      `Installed amikad ${DEFAULT_AMIKAD_VERSION} at ${installed}`,
    );
    // Installed once: a later run downloads nothing.
    h.fetcher.mockClear();
    expect(await ensureAmikad({}, h.deps)).toBe(installed);
    expect(h.fetcher).not.toHaveBeenCalled();
  });

  it("refuses an archive that does not match the release's checksums", async () => {
    const { checksums } = release();
    const { bytes: tampered } = release("#!/bin/sh\necho evil\n");
    const h = harness({
      [`${TAG_URL}/${ARCHIVE}`]: tampered,
      [`${TAG_URL}/checksums.txt`]: checksums,
    });
    await expect(ensureAmikad({}, h.deps)).rejects.toThrow(
      /does not match .*checksums.txt; nothing was installed/,
    );
    expect(existsSync(installedAmikadPath(h.env))).toBe(false);
  });

  it("refuses an archive the checksums do not list", async () => {
    const { bytes } = release();
    const h = harness({
      [`${TAG_URL}/${ARCHIVE}`]: bytes,
      [`${TAG_URL}/checksums.txt`]: `${"0".repeat(64)}  other.tar.gz\n`,
    });
    await expect(ensureAmikad({}, h.deps)).rejects.toThrow(/lists no amikad_/);
  });

  it("says which download failed", async () => {
    const h = harness({});
    await expect(ensureAmikad({}, h.deps)).rejects.toThrow(
      /cannot download .*checksums.txt: HTTP 404/,
    );
  });

  it("uses amikad_path as it is, downloading nothing", async () => {
    const { bytes, checksums } = release();
    const h = harness({
      [`${TAG_URL}/${ARCHIVE}`]: bytes,
      [`${TAG_URL}/checksums.txt`]: checksums,
    });
    const dev = path.join(h.env.AMIKA_HOSTD_HOME, "dev-amikad");
    writeFileSync(dev, "#!/bin/sh\n", { mode: 0o755 });
    expect(await ensureAmikad({ amikadPath: dev }, h.deps)).toBe(dev);
    expect(h.fetcher).not.toHaveBeenCalled();
    expect(amikadBinary({ amikadPath: dev }, h.env)).toBe(dev);
    expect(amikadBinary({}, h.env)).toBe(installedAmikadPath(h.env));
    await expect(
      ensureAmikad({ amikadPath: `${dev}-missing` }, h.deps),
    ).rejects.toThrow(/not an executable file/);
  });
});

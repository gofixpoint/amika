/** Smoke-test the release bundle: it must run under plain node, alone. */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const packageDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
// A directory with no node_modules above it, so every import the bundle makes
// must resolve to a Node builtin or to code inlined into the file.
const workDir = mkdtempSync(path.join(tmpdir(), "amika-hostd-bundle-"));

afterAll(() => rmSync(workDir, { recursive: true, force: true }));

describe("release bundle", () => {
  it("prints the CLI help with no node_modules", () => {
    const bundle = path.join(workDir, "amika-hostd.mjs");
    execFileSync(
      process.execPath,
      [path.join(packageDir, "scripts/bundle.mjs"), bundle],
      { cwd: packageDir },
    );

    const output = execFileSync(process.execPath, [bundle, "--help"], {
      cwd: workDir,
      env: { PATH: process.env.PATH },
      encoding: "utf8",
    });
    expect(output).toContain("Usage: amika-hostd <command>");
  }, 30_000);
});

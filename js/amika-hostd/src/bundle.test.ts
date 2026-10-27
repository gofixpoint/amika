/** Smoke-test the release bundle: it must run under plain node, alone. */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

  it("prints the build metadata it was bundled with", () => {
    const bundle = path.join(workDir, "versioned.mjs");
    execFileSync(
      process.execPath,
      [path.join(packageDir, "scripts/bundle.mjs"), bundle],
      {
        cwd: packageDir,
        env: {
          ...process.env,
          AMIKA_HOSTD_VERSION: "v1.2.3-rc.1",
          AMIKA_HOSTD_COMMIT: "abcdef123456",
          AMIKA_HOSTD_BUILD_DATE: "2026-03-17T12:00:00Z",
        },
      },
    );

    const output = execFileSync(process.execPath, [bundle, "version"], {
      cwd: workDir,
      env: { PATH: process.env.PATH },
      encoding: "utf8",
    });
    expect(output).toBe(
      "version: v1.2.3-rc.1\ncommit: abcdef123456\ndate: 2026-03-17T12:00:00Z\n",
    );
  }, 30_000);

  it("inlines the tunnel's dependencies, CommonJS ones included", () => {
    // `ws` is CommonJS and calls `require("events")` as it loads. esbuild
    // rewrites that to a helper that throws in ESM output unless a real
    // `require` is in scope, which the bundler's banner supplies. Without
    // the banner this fails at startup with `Dynamic require of "events"
    // is not supported`, and no test on `src/index.ts` would catch it
    // until the daemon imports the tunnel.
    const entry = path.join(workDir, "tunnel-entry.ts");
    const internal = path.join(packageDir, "src/internal");
    writeFileSync(
      entry,
      [
        `import { TunnelClient } from "${internal}/tunnel-client.js";`,
        `import { virtualServer } from "${internal}/tunnel-serving.js";`,
        `import { dialTunnel } from "${internal}/tunnel-dial.js";`,
        "console.log(",
        "  typeof TunnelClient, typeof virtualServer, typeof dialTunnel,",
        ");",
      ].join("\n"),
    );
    const bundle = path.join(workDir, "tunnel.mjs");
    execFileSync(
      process.execPath,
      [path.join(packageDir, "scripts/bundle.mjs"), bundle, entry],
      { cwd: packageDir },
    );

    const output = execFileSync(process.execPath, [bundle], {
      cwd: workDir,
      env: { PATH: process.env.PATH },
      encoding: "utf8",
    });

    expect(output.trim()).toBe("function function function");
  }, 30_000);
});

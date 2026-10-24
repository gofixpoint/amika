/**
 * Bundle the daemon and its npm dependencies into one ESM file that runs under
 * plain `node`. This is the file the release tarball ships and
 * `install-amika-hostd.sh` installs.
 *
 * Every dependency is inlined except `smolmachines`, smolvm's engine: it
 * finds its native addon, boot helper and guest rootfs on disk next to its
 * own files, so it is installed beside the bundle, in `node_modules`, and
 * loaded from there at runtime.
 *
 * The banner is not decoration. Several dependencies are CommonJS and call
 * `require` for Node builtins at load time -- `ws` is the one the tunnel
 * brings in. esbuild rewrites those calls to a helper that throws
 * `Dynamic require of "events" is not supported` in ESM output, unless a
 * real `require` is in scope, which the helper then uses instead. Without
 * the banner the bundle fails on its first import of such a module, at
 * startup, with no way to catch it.
 *
 * Usage: node scripts/bundle.mjs [outfile] [entry]
 *   outfile defaults to dist/bundle/amika-hostd.mjs, entry to src/index.ts.
 *   A second entry point is for tests that bundle one part of the daemon;
 *   the release always bundles the default one.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const packageDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const outfile = path.resolve(
  process.argv[2] ?? path.join(packageDir, "dist/bundle/amika-hostd.mjs"),
);

await build({
  entryPoints: [
    process.argv[3]
      ? path.resolve(process.argv[3])
      : path.join(packageDir, "src/index.ts"),
  ],
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  // The minimum Node.js version install-amika-hostd.sh accepts (NODE_MIN_MAJOR).
  target: "node22",
  external: ["smolmachines"],
  banner: {
    js: [
      'import { createRequire as __createRequire } from "node:module";',
      "const require = __createRequire(import.meta.url);",
    ].join("\n"),
  },
  logLevel: "warning",
});

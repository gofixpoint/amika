/**
 * Bundle the daemon and its npm dependencies into one ESM file that runs under
 * plain `node`. This is the file the release tarball ships and
 * `install-amika-hostd.sh` installs.
 *
 * Every dependency is inlined except `smolmachines`, smolvm's engine: it
 * finds its native addon, boot helper and guest rootfs on disk next to its
 * own files, so it is installed beside the bundle, in `node_modules`, and
 * loaded only when the daemon first needs a machine.
 *
 * Usage: node scripts/bundle.mjs [outfile]  (default dist/bundle/amika-hostd.mjs)
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const packageDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const outfile = path.resolve(
  process.argv[2] ?? path.join(packageDir, "dist/bundle/amika-hostd.mjs"),
);

await build({
  entryPoints: [path.join(packageDir, "src/index.ts")],
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  // The minimum Node.js version install-amika-hostd.sh accepts (NODE_MIN_MAJOR).
  target: "node22",
  external: ["smolmachines"],
  logLevel: "warning",
});

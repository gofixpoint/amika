/**
 * Bundle the daemon and its npm dependencies into one ESM file that runs under
 * plain `node`, with no `node_modules`. This is the file the release tarball
 * ships and `install-amika-hostd.sh` installs.
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
  // Some dependencies (undici) are CommonJS and `require` Node builtins,
  // which an ESM bundle cannot do without a real `require` in scope.
  banner: {
    js: 'import { createRequire as __amikaCreateRequire } from "node:module"; const require = __amikaCreateRequire(import.meta.url);',
  },
  logLevel: "warning",
});

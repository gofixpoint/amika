const path = require("node:path");

/**
 * Enforce Go-style `internal/` visibility boundaries.
 *
 * For a module at `foo/internal/bar`, the boundary root is the PARENT of the
 * (innermost) `internal/` directory — `foo/`. The module is importable only
 * from files anywhere within the `foo/` subtree:
 *
 *   foo/internal/**   ✅ nested inside internal/
 *   foo/bazinga.ts    ✅ sibling of internal/
 *   foo/other/baz.ts  ✅ deeper descendant of foo/
 *   sibling/x.ts      ❌ outside foo/
 *   foo2/x.ts         ❌ outside foo/
 *
 * This mirrors Go, where `.../a/internal/...` is importable only by code rooted
 * at `.../a`. For nested internals, the innermost `internal` segment's parent
 * is the root.
 *
 * The boundary applies to both `import ... from "X"` and re-exports
 * (`export ... from "X"`), and to both relative specifiers (`./internal/...`)
 * and the `@/` path alias, which every package's tsconfig maps to its own
 * `src/`. Tests get no exemption: a file's legality depends only on its own
 * location.
 */

const ALIAS_PREFIX = "@/";

/**
 * Resolve an import specifier to an absolute path, or null when it is out of
 * scope (a bare package specifier, or an alias we cannot anchor).
 */
function resolveSpecifier(source, importer) {
  if (source.startsWith(".")) {
    return path.resolve(path.dirname(importer), source);
  }
  if (source.startsWith(ALIAS_PREFIX)) {
    // `@/*` maps to `<package>/src/*` in every package's tsconfig. Recover the
    // importing file's own `src/` root and re-root the specifier there.
    const marker = `${path.sep}src${path.sep}`;
    const at = importer.indexOf(marker);
    if (at === -1) return null;
    const srcRoot = importer.slice(0, at + marker.length - 1);
    return path.join(srcRoot, source.slice(ALIAS_PREFIX.length));
  }
  // Bare specifiers (npm packages, other workspace packages) are out of scope;
  // package boundaries are enforced by the package system itself.
  return null;
}

/**
 * The boundary root for a resolved path that points into an `internal/`
 * directory: the parent of the innermost (last) `internal` path segment.
 * Returns null when there is no such segment.
 */
function internalBoundaryRoot(resolvedPath) {
  const segments = resolvedPath.split(path.sep);
  for (let i = segments.length - 1; i >= 0; i--) {
    if (segments[i] === "internal") {
      if (i === 0) return null;
      return segments.slice(0, i).join(path.sep);
    }
  }
  return null;
}

module.exports = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow importing an internal/ module from outside its parent subtree (Go-style boundary)",
    },
    schema: [],
  },
  create(context) {
    function check(node) {
      // ExportNamedDeclaration without a `from` clause has no source.
      const source = node.source && node.source.value;
      if (typeof source !== "string") return;
      if (!source.includes("/internal/") && !source.endsWith("/internal")) {
        return;
      }

      const importer = context.getFilename();
      const resolved = resolveSpecifier(source, importer);
      if (resolved === null) return;

      const boundaryRoot = internalBoundaryRoot(resolved);
      if (boundaryRoot === null) return;

      // Legal iff the importing file lives within the boundary root subtree.
      if (importer.startsWith(boundaryRoot + path.sep)) return;

      const name = path.basename(boundaryRoot);
      context.report({
        node,
        message:
          `'${source}' reaches into '${name}/internal', which is only ` +
          `importable from within '${name}/'. Import it from a public module ` +
          `in '${name}', or move this file into that subtree.`,
      });
    }

    return {
      ImportDeclaration: check,
      ExportNamedDeclaration: check,
      ExportAllDeclaration: check,
    };
  },
};

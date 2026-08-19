/**
 * Guards the `@amika/sandbox/client` invariant documented in `client.ts`: no
 * provider SDK and no `node:` built-in anywhere in its module graph.
 *
 * This is a bundler constraint, so it cannot be observed by importing the entry
 * (Node resolves `node:fs` happily). Instead we walk the static import graph
 * from `client.ts` and fail on the first forbidden specifier, reporting the
 * path that pulled it in.
 *
 * Without this, a client-reachable module that reaches a provider SDK only
 * fails much later, in a consumer's browser build, as an opaque Turbopack
 * "chunking context does not support external modules" error.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const CLIENT_ENTRY = resolve(import.meta.dirname, "client.ts");

/** Runtime deps that carry a provider SDK (and transitively `node:` built-ins). */
const FORBIDDEN_PACKAGES = [
  "@daytona/api-client",
  "@daytonaio/sdk",
  "@vercel/sandbox",
  "e2b",
  "freestyle",
];

/** Every `import`/`export ... from "..."` specifier in `source`. */
function importSpecifiers(source: string): string[] {
  // Matches the `from "..."` of static import/export declarations plus bare
  // side-effect imports (`import "..."`). Type-only declarations are included
  // deliberately: `import type` is erased, but `import { type X }` is not
  // distinguishable here, so we over-collect rather than miss a value import.
  const pattern = /(?:from|import)\s*["']([^"']+)["']/g;
  return [...source.matchAll(pattern)].map((match) => match[1]);
}

/** Resolve a relative specifier to a concrete `.ts` file on disk. */
function resolveRelative(fromFile: string, specifier: string): string | null {
  const base = resolve(dirname(fromFile), specifier);
  for (const candidate of [`${base}.ts`, `${base}/index.ts`]) {
    try {
      readFileSync(candidate, "utf8");
      return candidate;
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * Walk the import graph from `entry`, returning the first violation found as
 * the chain of files leading to it.
 */
function findForbiddenImport(entry: string): {
  specifier: string;
  chain: string[];
} | null {
  const visited = new Set<string>();
  const queue: { file: string; chain: string[] }[] = [
    { file: entry, chain: [entry] },
  ];

  while (queue.length > 0) {
    const { file, chain } = queue.shift()!;
    if (visited.has(file)) continue;
    visited.add(file);

    for (const specifier of importSpecifiers(readFileSync(file, "utf8"))) {
      if (specifier.startsWith(".")) {
        const next = resolveRelative(file, specifier);
        if (next) queue.push({ file: next, chain: [...chain, next] });
        continue;
      }
      const forbidden =
        specifier.startsWith("node:") ||
        FORBIDDEN_PACKAGES.some(
          (pkg) => specifier === pkg || specifier.startsWith(`${pkg}/`),
        );
      if (forbidden) return { specifier, chain };
    }
  }
  return null;
}

describe("@amika/sandbox/client module graph", () => {
  it("pulls in no provider SDK and no node: built-in", () => {
    const violation = findForbiddenImport(CLIENT_ENTRY);
    const detail = violation
      ? `"${violation.specifier}" reached via:\n  ${violation.chain.join("\n  ")}`
      : "";
    expect(detail).toBe("");
  });

  it("detects a forbidden import when one exists (guards the walker)", () => {
    // Sanity-check the walker against a known-bad entry: the root barrel does
    // pull in the provider SDKs, so a null result here would mean the graph
    // walk is silently finding nothing.
    const violation = findForbiddenImport(
      resolve(import.meta.dirname, "index.ts"),
    );
    expect(violation).not.toBeNull();
  });
});

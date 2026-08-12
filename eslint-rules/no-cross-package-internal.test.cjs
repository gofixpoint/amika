const { describe, it } = require("node:test");
const { RuleTester } = require("eslint");
const rule = require("./no-cross-package-internal.cjs");

// Wire ESLint's RuleTester into node:test so each case is a subtest.
RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester({
  languageOptions: { ecmaVersion: 2022, sourceType: "module" },
});

// A package's `src/` root; `@/` resolves here for files under it.
const SRC = "/repo/js/pkg/src";

ruleTester.run("no-cross-package-internal", rule, {
  valid: [
    // Sibling of internal/, relative specifier.
    {
      filename: `${SRC}/foo/bar.ts`,
      code: `import { x } from "./internal/baz";`,
    },
    // Sibling of internal/, alias specifier.
    {
      filename: `${SRC}/foo/bar.ts`,
      code: `import { x } from "@/foo/internal/baz";`,
    },
    // Nested inside internal/, importing a sibling internal module (alias).
    {
      filename: `${SRC}/foo/internal/deep/a.ts`,
      code: `import { x } from "@/foo/internal/baz";`,
    },
    // Deeper descendant of the boundary root (alias) — the design decision:
    // the whole foo/ subtree is in scope, not just direct siblings.
    {
      filename: `${SRC}/foo/other/baz.ts`,
      code: `import { x } from "@/foo/internal/bar";`,
    },
    // Deeper descendant of the boundary root (relative).
    {
      filename: `${SRC}/foo/other/baz.ts`,
      code: `import { x } from "../internal/bar";`,
    },
    // Barrel re-export from within the subtree.
    {
      filename: `${SRC}/foo/index.ts`,
      code: `export { x } from "./internal/bar";`,
    },
    // Nested internals: innermost internal's parent is the boundary root.
    {
      filename: `${SRC}/foo/internal/a/internal/b.ts`,
      code: `import { x } from "@/foo/internal/a/internal/c";`,
    },
    // Non-internal import is never flagged.
    {
      filename: `${SRC}/foo/bar.ts`,
      code: `import { x } from "@/other/baz";`,
    },
    // Bare specifiers (npm / workspace packages) are out of scope even when
    // their path contains an internal/ segment.
    {
      filename: `${SRC}/foo/bar.ts`,
      code: `import x from "some-pkg/internal/thing";`,
    },
    // Export with no source clause has nothing to resolve.
    {
      filename: `${SRC}/foo/bar.ts`,
      code: `export const y = 1;`,
    },
  ],
  invalid: [
    // Sibling directory reaching into foo/internal (alias).
    {
      filename: `${SRC}/sibling/x.ts`,
      code: `import { x } from "@/foo/internal/bar";`,
      errors: 1,
    },
    // Adjacent directory whose name prefixes the boundary root (foo2 vs foo).
    {
      filename: `${SRC}/foo2/x.ts`,
      code: `import { x } from "@/foo/internal/bar";`,
      errors: 1,
    },
    // Outside the subtree via a relative specifier.
    {
      filename: `${SRC}/sibling/x.ts`,
      code: `import { x } from "../foo/internal/bar";`,
      errors: 1,
    },
    // A parent barrel cannot reach into a child's internal (alias).
    {
      filename: `${SRC}/lib/index.ts`,
      code: `import { x } from "@/lib/sub/internal/thing";`,
      errors: 1,
    },
    // Re-export leaking a nested internal from the package barrel above it.
    {
      filename: `${SRC}/index.ts`,
      code: `export * from "./foo/internal/scripts";`,
      errors: 1,
    },
    // Tests get no exemption — mirrors the KAPRO-709 escape a red-team test
    // used to slip through.
    {
      filename: `/repo/js/coding-agents/src/lib/api-keys/api-keys.redteam.test.ts`,
      code: `import { InMemoryApiKeyDirectory } from "@/lib/workos/internal/api-key-directory";`,
      errors: 1,
    },
  ],
});

# JS Workspace Conventions

Conventions that apply to every package under `js/`. Package-specific
guidance lives in each package's own `AGENTS.md`.

These conventions are shared with `amika-mono`, Amika's private control-plane
monorepo, which consumes `js/sandbox` from this repo as a git submodule. Keep
the two copies of this file in agreement: a convention that drifts here will
surface as a review disagreement when a change flows back into amika-mono.
Where a rule below cites an example that lives only in amika-mono, it is
labelled as such — look for `amika-mono` checked out as a sibling worktree
rather than searching for that path in this repo.

## Exhaustive branching over union types

When branching on a closed union (a Zod enum's inferred type, a
discriminated union's tag, a string-literal union), use branching that lets
TypeScript catch unhandled union members. This can be a `switch` with a case
per member and a `default` that calls an `assertNever`-style helper taking
`never`:

```ts
function assertNever(value: never): never {
  throw new Error(`Unhandled case: ${String(value)}`);
}

switch (mode) {
  case "pat":
    // ...
    break;
  case "app_token":
    // ...
    break;
  default:
    assertNever(mode);
}
```

An exhaustive `if` / `else if` / `else` chain is also fine as long as the
final `else` assigns the checked value to `never` or passes it to an
`assertNever`-style helper:

```ts
if (mode === "pat") {
  // ...
} else if (mode === "app_token") {
  // ...
} else {
  assertNever(mode);
}
```

Adding a member to the union then breaks compilation at every branch that
lacks a case, instead of silently falling through a non-exhaustive fallback.

## `*Parsed` types

When an outer layer accepts input in one shape and an inner layer parses it
into a stronger, further-validated shape, suffix the inner type with `Parsed`
(e.g. `FooParsed`). Reserve this for parsing that goes beyond what the
boundary's own schema/validator already guarantees; don't apply it to every
validated type.

A Zod schema that fully validates its input is not a parse step, so don't
suffix schemas or their inferred types with `Parsed`. Use `*Parsed` only when
an inner layer narrows further than the schema can express, using context the
schema can't see.

## Prefer Zod over hand-rolled object parsing

When validating or narrowing data whose shape the type system does not already
guarantee (third-party API responses, request bodies, `unknown` values,
env-derived JSON), define a Zod schema and use `safeParse` / `parse` rather than
hand-rolled `typeof` / `in` / property checks. One schema declares the accepted
shape, fails closed on anything unexpected, and yields a typed result, so the
narrowing does not drift from the type. Reserve manual narrowing for the rare
case a schema cannot express (see `*Parsed` types above).

## Static imports only

Import every module statically at the top of the file. Do not use an
`import(...)` expression to defer or conditionally pull in a module, and do not
use one in a type position: write `import type { T } from "./module"` at the
top rather than `type T = import("./module").T`. Dynamic and inline imports
hide dependencies from the module graph and are usually a workaround for a
dependency that shouldn't be reached from that module in the first place. If a
heavy or environment-specific dependency is a problem, inject it (pass it in)
or split the module so consumers don't pull it in, rather than deferring the
import.

Some cases genuinely require an `import(...)` expression. These are allowed,
and the list is illustrative rather than a complete inventory of what is in the
tree today:

- Code splitting through `next/dynamic` or `React.lazy`, which take a loader
  function by construction.
- `typeof import("...")` inside a Vitest `importOriginal<T>()` generic, which
  has no top-level `import type` equivalent that keeps the call typed.
- `await import("./module")` after a `vi.mock(...)` call, where the mock must
  be hoisted above the import to take effect.

This rule is documentation, not lint-enforced; prefer a static import whenever
one of the three cases above does not apply.

## Module organization

Helpers used only within a package go under an `internal/` subdirectory. The
`no-cross-package-internal` lint rule (shipped from the repo-root
`eslint-rules/`) forbids a relative import that reaches into **another**
package's `internal/` directory, and tells you to import from that package's
public entry point instead. Imports of your own package's `internal/` files are
allowed; only cross-package reaches are flagged.

Every `js/*` package wires the rule the same way, in its `eslint.config.mjs`:

```js
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const localRules = require("../../eslint-rules/index.cjs");

// ...inside the config array:
{
  plugins: { local: localRules },
  rules: {
    "local/no-cross-package-internal": "error",
  },
}
```

When adding a package, copy an existing `eslint.config.mjs` so this block comes
along — do not hand-write a config that omits it.

## Package scripts & CI

Every package under `js/` must expose a uniform script surface and a matching
`check-<package>` job in `.github/workflows/ci.yml` that runs them in order:
Format check → Typecheck → Lint → Test → Build (Build only where the package
emits an artifact).

| Script        | Command              | Notes                                                 |
| ------------- | -------------------- | ----------------------------------------------------- |
| `lint`        | `eslint .`           | Real ESLint, not a `tsc` stand-in.                    |
| `typecheck`   | `tsc --noEmit`       |                                                       |
| `test`        | `vitest run`         | Use `vitest run --passWithNoTests` until tests exist. |
| `format`      | `prettier --write .` | Writes fixes.                                         |
| `formatcheck` | `prettier --check .` | The check CI runs.                                    |
| `build`       | `tsc` / etc.         | **Only if the package emits an artifact.**            |

A `tsc` invocation with `noEmit` is a typecheck, not a build; do not dress it
up as a `build` script or a CI Build step. `js/sandbox` is consumed as
TypeScript source by its downstream consumers, so it has no `build` script.

Prettier runs with defaults — there is no repository prettier config file.
Every package invokes the **workspace** prettier (`prettier --check .` /
`prettier --write .`), never `pnpm dlx prettier` (which floats to the latest
published version and drifts from what CI checks). Prettier is pinned to a
single version across the workspace (one entry in `pnpm-lock.yaml`), and the
pre-commit hook (`.lintstagedrc.mjs`) runs that same version — otherwise
hook-written formatting would fail CI's `formatcheck`. When bumping prettier,
bump every package's devDependency and the hook's pinned version **in both this
repo and amika-mono**, whose hook carries the same pin.

`.lintstagedrc.mjs` matches packages by the `PACKAGE_BY_PREFIX` map
(`js/<dir>/` → package name). **When you add a package under `js/`, register it
there** in addition to adding its CI job — otherwise a commit touching only
that package skips the hook's lint and typecheck.

## Dependency versions

The lint/format/test toolchain is pinned to the same versions across packages
(no pnpm catalog). When adding tooling to a package, match what `js/sandbox`
already uses:

```
@eslint/js         ^9.39.2
eslint             ^9
typescript-eslint  ^8.55.0
globals            ^16.4.0
prettier           3.8.3     (exact — see below)
vitest             4.1.0
```

`prettier` is pinned to an **exact** version rather than a caret range. This
repo and amika-mono resolve their own lockfiles independently, so a range lets
the two pick different patch versions of prettier — and prettier's output does
change across minor versions. When that happened during the submodule
migration, `js/sandbox` formatted clean under 3.8.3 and dirty under 3.9.6 on
byte-identical source. An exact pin is what keeps `formatcheck` agreeing across
both repos and both pre-commit hooks. Bump it in all four places at once:
this manifest, this table, and each repo's `.lintstagedrc.mjs`.

## Testing

We use [vitest](https://vitest.dev/) in every package that has tests. Each
package keeps its own config so it can pick the right environment (`node` for
server-only logic, `jsdom` for client/React code) and wire up its own aliases
and setup files.

| Suffix                  | What it is                | Picked up by               |
| ----------------------- | ------------------------- | -------------------------- |
| `*.test.ts`             | Runtime unit test         | `pnpm test`                |
| `*.integration.test.ts` | Runtime integration test  | `pnpm test:integration`    |
| `*.test-d.ts`           | Type-level assertion file | `pnpm run typecheck` (tsc) |

Unit configs exclude `*.integration.test.ts` so slow or externally-dependent
tests don't run by accident. The default vitest include glob
(`**/*.{test,spec}.?(c|m)[jt]s?(x)`) intentionally does not match `.test-d.ts`
— the dash before `d` puts it outside the pattern.

Prefer dependency injection over module mocks: pass collaborators in as
arguments so a test can supply a fake, rather than reaching for `vi.mock`.

## Workspace layout

`sdk/typescript` (`@amika/sdk`) is deliberately **not** a member of this
workspace. It is a self-contained pnpm workspace with its own
`pnpm-workspace.yaml`, `pnpm-lock.yaml`, and `packageManager` pin, and its CI
and npm publish workflows install from that lockfile. Run its commands from
`sdk/typescript/`, not from the repo root.

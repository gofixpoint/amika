# AGENTS.md

TypeScript SDK for Amika (`@amika/sdk`).

## Build check

On macOS under Node 26, run `pnpm run build` with
`TMPDIR=$(realpath "$TMPDIR")`. Otherwise its last step,
`scripts/check-package.mjs`, fails with "package types entry point must
resolve" because `TMPDIR` sits under the `/var` to `/private/var` symlink.

## Test tiers

Two tiers, run by two separate commands:

- **Unit** (`pnpm test`): offline, mocked HTTP, runs in CI.
- **Functional** (`pnpm test:functional`): hits a real deployed server,
  run on-demand, never in CI.

Functional tests use the `*.functional.test.ts` filename suffix. The two
vitest configs are mirror images and must stay in sync: `vitest.config.ts`
(unit) _excludes_ both `test/functional/**/*.test.ts` and
`**/*.functional.test.ts`, while `vitest.functional.config.ts` _includes_
both. When you add a functional test, the suffix is what routes it, so it
can live anywhere.

`describeFunctional` (in `test/functional/helpers.ts`) skips every
functional suite when `AMIKA_API_URL` is unset, so a bare
`pnpm test:functional` is a safe no-op.

## Production ban

Functional tests are hard-banned from production. `assertNotProdUrl`
(`test/functional/prod-guard.ts`) blocks `app.amika.dev` and `amika.dev`,
and is called both in the functional `globalSetup` (fails the run before
any network call) and in `makeClient()` as defense in depth. There is no
override by design. Do not weaken this; point functional runs at staging
(`https://app.staging-amika.dev`) or an ephemeral deployment.

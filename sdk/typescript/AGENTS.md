# AGENTS.md

TypeScript SDK for Amika (`@amika/sdk`).

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

## Identifying resources

In the resource API (`client.rigs`, `client.services`, `client.snapshots`,
`client.agentSessions`), every parameter or field that names a rig (or another
referenced resource) accepts a `ResourceRef` (`RigRef` for rigs), exported from
`src/resource-ref.ts`:

- A plain string is a `ref`: the server matches it by ID or name and rejects a
  value that is one resource's ID and another's name with 409.
- `{ ref, by: "id" | "name" | "ref" }` pins the kind.
- Never infer a kind from the string. A `name=` or `id=` prefix is part of the
  value, not a selector.

The deprecated flat `LegacyClient` methods take plain strings; do not widen them.

Map every reference through `src/internal/resource-ref.ts`, never by hand. It
validates (an empty or whitespace `ref` and an unknown `by` throw `AmikaError`
before any request) and produces the API's wire spellings: a path segment plus
`by` when the resource is the endpoint's primary one, `sandbox_by` when it is a
parent in the path, and `*_id` / `*_name` / `*_ref` fields in bodies and some
list filters. A pinned kind always sends its selector; a plain string omits it
where the server's default is already `ref`, so plain-string requests keep their
earlier wire form. A handle sends the caller's reference as given until it has
fetched its resource, then pins `{ ref: id, by: "id" }`.

When a reference field replaces an older one, keep the old field as a
`@deprecated` alias that maps onto the new form: a former "name or ID" string
becomes a plain-string ref, and a former ID-only field becomes
`{ ref, by: "id" }`. Pass the canonical field and its aliases to `pickRef` in
precedence order: the first non-empty one wins, so an empty canonical value
falls through to an alias rather than shadowing it. In a list filter, an empty
deprecated alias keeps its old meaning of no filter (`alias || undefined`); an
empty canonical field throws. Keep the type-compatibility tricks for older
callers described in `src/snapshots/types.ts`.

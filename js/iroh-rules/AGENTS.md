# @amika/iroh-rules

The signed rules record of the iroh transport (spec 035, track B). The
control plane encodes and signs it. hostd verifies it and runs the two
checks on each connection and stream.

The contract is amika-mono's
`specs/035-host-connection-drops.d/iroh-contracts.md`, section "The rules
record". Change that document first, then this package.

## Rules

- **Run in Node 22+ and in Cloudflare Workers.** Use Web Crypto, `Uint8Array`
  and `TextEncoder` only. Do not use `Buffer` or a `node:` import in library
  code. ESLint refuses both outside `*.test.ts`.
- **Verify the signature before you parse the payload.** Sign and verify the
  exact payload bytes, never a re-encoding of them.
- **Ignore unknown fields. Refuse unknown values of known fields.** A new
  value that changes access comes with a required feature.
- **Keep `test-vectors.json` in step with the code.** Other languages
  verify against it. Run `pnpm run update-test-vectors` after a change to
  `src/testing/build-test-vectors.ts`. The tests fail while the file is
  out of date.
- **Do not trust the test keys.** They are RFC 8032's published test keys.

## Checks

```bash
pnpm run formatcheck && pnpm run typecheck && pnpm run lint && pnpm run test
```

# @amika/iroh-rules

The signed rules record of the iroh transport (spec 035, track B). The
control plane encodes and signs it. hostd verifies it and runs the two
checks on each connection and stream. For locked orgs (phase 1b), it also
holds the lock log, rules that lock keys sign, recovery codes and signed
requests.

The contract is amika-mono's
`specs/035-host-connection-drops.d/iroh-contracts.md`, sections "The rules
record" and "Locked orgs (phase 1b)". Change that document first, then
this package.

## Rules

- **Run in Node 22+ and in Cloudflare Workers.** Use Web Crypto, `Uint8Array`
  and `TextEncoder` only. Do not use `Buffer` or a `node:` import in library
  code. ESLint refuses both outside `*.test.ts`.
- **Verify the signature before you parse the payload.** Sign and verify the
  exact payload bytes, never a re-encoding of them.
- **Use one domain string for each kind of signed payload.** Rules use
  `amika-iroh-rules-v1`, lock entries `amika-iroh-lock-v1`, and signed
  requests `amika-iroh-request-v1`. Do not verify one kind with another
  kind's domain.
- **Keep the phase 1 exports and behavior.** Add phase 1b code as new
  exports. Do not add `lock_v1` to `SUPPORTED_FEATURES`.
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

# Sandbox package

- Import server APIs from `@amika/sandbox`. Start with `createSandboxProvider`,
  `SandboxProvider`, and `Sandbox`. Use `getSandboxAdapter` for provisioning.
- Browser code must import from `@amika/sandbox/client` to avoid provider SDKs.
- To add a provider, follow [src/providers/README.md](src/providers/README.md).
  Its "Testing a provider" section says which tests to run and in what order.
- Install dependencies at the repo root. Run package checks with
  `pnpm --filter @amika/sandbox <script>`: `typecheck`, `lint`, `formatcheck`,
  and `test`. `test:integration` runs the provider contract suite against a
  real vendor; it skips unless `TEST_SANDBOX_CONTRACT_PROVIDER` is set. It
  fails when any resource it created could not be deleted; `sweep:contract`
  deletes what a killed run left behind.

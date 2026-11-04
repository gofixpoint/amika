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

## Scope

`@amika/sandbox` is a general library for sandbox providers. It must not
know that the Amika control plane (`amika-mono`) exists.

- Do not add concepts that only the control plane uses. Examples: guest
  provisioning, organizations and users, rig policy, and feature flags.
- A provider capability tells what a caller can do through that provider.
  It does not tell what the control plane does with a rig.
- One provider can run rigs that support different operations. An example
  is `amika-hostd` with its runtimes. The caller decides which operations
  to use for each rig. Do not add a second provider for this.
- Put rules that are specific to Amika in the control plane.

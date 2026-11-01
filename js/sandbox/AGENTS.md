# Sandbox package

- Import server APIs from `@amika/sandbox`. Start with `createSandboxProvider`,
  `SandboxProvider`, and `Sandbox`. Use `getSandboxAdapter` for provisioning.
- Browser code must import from `@amika/sandbox/client` to avoid provider SDKs.
- To add a provider, follow [src/providers/README.md](src/providers/README.md).
- Install dependencies at the repo root. Run package checks with
  `pnpm --filter @amika/sandbox <script>`: `typecheck`, `lint`, `formatcheck`,
  and `test`.

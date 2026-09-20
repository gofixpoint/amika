# CLI E2E tests

These are black-box tests. Cases must exercise the selected `amika` executable
through argv, stdin, environment, stdout, stderr, and exit status rather than
importing implementation packages.

## Real-API safety

- Files prefixed with `api-` can create billable remote resources. Keep them
  behind both `AMIKA_RUN_E2E=1` and `AMIKA_RUN_E2E_API=1`.
- Register every created resource immediately so the reverse-order cleanup
  ledger can delete it after a later failure.
- Preserve enough timeout headroom for cleanup. A `go test` timeout kills the
  process before deferred cleanup can run.
- Use run-unique names for upserted remote resources.
- Never put API keys or other secret values in case argv, transcripts, wrapper
  files, or committed fixtures.

## Alternate control planes and SSH

Canonical `rig ssh` has two control-plane calls. The outer CLI resolves the rig
and prepares an alias; system OpenSSH then invokes the managed `ProxyCommand`,
which re-executes `amika plumbing ssh-stdio-proxy` and requests a fresh SSH
session. Both processes must target the same control plane.

Do not assume a one-shot `AMIKA_API_URL=...` assignment survives that shell
boundary. Hosted rigs set `BASH_ENV=/etc/environment`, and non-interactive Bash
sources that file before running an OpenSSH `ProxyCommand`. If
`/etc/environment` contains another `AMIKA_API_URL`, the proxy silently targets
that deployment and reports `Sandbox not found` for a rig created on the test
deployment.

For an alternate API target:

1. Build the CLI from the checkout under test.
2. Create an absolute, executable wrapper that exports the intended
   `AMIKA_API_URL` and then `exec`s that exact build.
3. Run the suite with `AMIKA_BINARY_PATH` pointing at the wrapper.
4. Point `AMIKA_E2E_OPENAPI_URL` at the same deployment.

The E2E entry point uses `AMIKA_BINARY_PATH` as the executable under test, so
the outer command and generated `ProxyCommand` share the wrapper. Real-API SSH
tests must use the canonical `rig ssh` command.

## Case maintenance

- Keep provider-specific values in top-level `vars` mappings rather than loose
  `@oneof` assertions.
- A remote command after `rig ssh` must be one `cmd` element as documented in
  `README.md`; OpenSSH joins and re-splits it through the remote shell.
- Run `make test-e2e` after changing any case, even when real-API tests cannot
  run. This catches malformed fixtures and obsolete CLI flags.

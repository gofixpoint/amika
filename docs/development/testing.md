# Development Testing

This guide defines the automated test pyramid for Amika and the command flow to run it locally.

## Test Pyramid

1. Unit tests: fast, deterministic, no Docker dependency.
2. Integration tests: command and package behavior across process/runtime boundaries.
3. Contract tests: lock user-visible CLI behavior and key error contracts.
4. Docker-backed integration tests: opt-in suites that require Docker.

## Testing Principles

These shape the code under test, not the tests themselves.

### Prefer dependency injection over mocks

Shape code so collaborators (Docker clients, stores, clocks, HTTP
clients) are passed in as arguments or carried on a context struct, and
substitute a fake or real implementation at the call site.
`go/internal/ports/` defines interfaces for Docker, store, clock,
idgen, runner, and filesystem operations; production wiring lives in
`go/internal/app/`, and tests pass fakes.

Why:

- Dependencies are visible in the type signature; the compiler catches
  mismatches when names change.
- The same seam accepts a real implementation or a hand-written fake.
- No package-level mock state leaks between tests.

Reach for `gomock`, monkey-patching, or build-tag indirection only when
injection is genuinely impractical (e.g. a third-party package-level
function). Leave a comment explaining why.

### Functional core, imperative shell

Prefer stateless, pure functions for business logic — they take inputs
and return outputs with no side effects. Isolate I/O (Docker calls,
filesystem, network) at the boundaries of the call stack. The
functional core is easy to unit-test; the shell is exercised by
integration and contract tests.

## Make Targets

| Target                  | What it runs                                                                                  |
| ----------------------- | --------------------------------------------------------------------------------------------- |
| `make test`             | `go test ./...` — all tests in one shot                                                       |
| `make test-unit`        | Unit tests only (excludes integration, contract, and legacy mount packages)                   |
| `make test-integration` | `go test ./test/integration/...`                                                              |
| `make test-contract`    | `go test ./test/contract/...`                                                                 |
| `make test-all`         | `test-unit` + `test-integration` + `test-contract`                                            |
| `make test-expensive`   | Sets `AMIKA_RUN_DOCKER_INTEGRATION=1` and `AMIKA_RUN_EXPENSIVE_TESTS=1`, then runs `test-all` |
| `make coverage`         | Runs `scripts/test/check_coverage.sh` against configured thresholds                           |
| `make ci`               | run all CI targets                                                                            |

## Command Flow

Run tests in this order:

1. Build: `make build`
2. Unit tests: `make test-unit`
3. Integration tests: `make test-integration`
4. Contract tests: `make test-contract`
5. Coverage gate: `make coverage`

Run all non-Docker suites with:

```bash
make test-all
```

Run CI-equivalent checks with:

```bash
make ci
```

## Docker-Backed Integration Tests (Opt-in)

Docker suites are disabled by default and run only when:

- `AMIKA_RUN_DOCKER_INTEGRATION=1`

Run them with:

```bash
AMIKA_RUN_DOCKER_INTEGRATION=1 make test-unit
AMIKA_RUN_DOCKER_INTEGRATION=1 make test-integration
```

## Expensive Preset Rebuild Tests (Opt-in)

The preset image rebuild test requires both Docker integration mode and the expensive toggle:

- `AMIKA_RUN_DOCKER_INTEGRATION=1`
- `AMIKA_RUN_EXPENSIVE_TESTS=1`

The simplest way to run these is with the make target, which sets both env vars and runs `test-all`:

```bash
make test-expensive
```

To run a single expensive test directly:

```bash
AMIKA_RUN_DOCKER_INTEGRATION=1 AMIKA_RUN_EXPENSIVE_TESTS=1 \
  go -C go test ./cmd/amika -run TestTopMaterialize_PresetAgentsAvailableOnPath -count=1
```

## Coverage Gates

Coverage thresholds are checked by `scripts/test/check_coverage.sh` and configured in:

- `go/test/coverage-baseline.env`

Current thresholds:

- `AMIKA_MIN_INTERNAL_COVERAGE=70.0`
- `AMIKA_MIN_CMD_COVERAGE=35.0`

You can override thresholds temporarily:

```bash
AMIKA_MIN_INTERNAL_COVERAGE=72.0 AMIKA_MIN_CMD_COVERAGE=36.0 make coverage
```

## Failure Triage Template

When filing or debugging a failing test, capture:

1. Exact command run.
2. Exit code.
3. Full stdout/stderr.
4. Whether Docker was available/running.
5. Relevant environment variables (`AMIKA_RUN_DOCKER_INTEGRATION`, `AMIKA_RUN_EXPENSIVE_TESTS`, coverage overrides).

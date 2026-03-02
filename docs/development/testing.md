# Development Testing

This guide defines the automated test pyramid for Amika and the command flow to run it locally.

## Test Pyramid

1. Unit tests: fast, deterministic, no Docker dependency.
2. Integration tests: command and package behavior across process/runtime boundaries.
3. Contract tests: lock user-visible CLI behavior and key error contracts.
4. Docker-backed integration tests: opt-in suites that require Docker.

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

Run with:

```bash
AMIKA_RUN_DOCKER_INTEGRATION=1 AMIKA_RUN_EXPENSIVE_TESTS=1 \
  go test ./cmd/amika -run TestTopMaterialize_PresetAgentsAvailableOnPath -count=1
```

## Coverage Gates

Coverage thresholds are checked by `scripts/test/check_coverage.sh` and configured in:

- `test/coverage-baseline.env`

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

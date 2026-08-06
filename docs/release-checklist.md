# Release Checklist

Run these checks against the staging environment before promoting a release to production.

## Prerequisites

- An `AMIKA_API_KEY` with sufficient permissions for the target environment
- Docker running locally (required by the Go e2e suite to build the `amika` binary)
- Node.js / pnpm installed (required by the TypeScript SDK functional suite)

## 1. Go E2E Tests

The e2e suite is a black-box runner that exercises the compiled `dist/amika` binary against a real API. It has two tiers:

- **Offline cases** (no `api-` prefix): no network, no credentials required.
- **Real-API cases** (`api-*.yaml`): talk to `AMIKA_API_URL` and may create billable resources; require `AMIKA_RUN_E2E_API=1`.

Run both offline and real-API cases against staging:

```bash
AMIKA_RUN_E2E=1 \
AMIKA_RUN_E2E_API=1 \
AMIKA_API_URL=https://app.staging-amika.dev/ \
AMIKA_API_KEY=<your-api-key> \
  make test-e2e-api
```

Or invoke Go directly from the repo root:

```bash
AMIKA_RUN_E2E=1 \
AMIKA_RUN_E2E_API=1 \
AMIKA_API_URL=https://app.staging-amika.dev/ \
AMIKA_API_KEY=<your-api-key> \
  go -C go test -v -timeout 20m ./test/e2e/...
```

To run offline cases only (no credentials needed):

```bash
make test-e2e
```

The suite builds the `amika` binary fresh before running, so `dist/amika` does not need to exist beforehand.

**Expected result:** all subtests under `TestE2ECases` pass, including `api-auth-status`, `api-sandbox-lifecycle`, `api-sandbox-list`, `api-secret-list`, `api-service-lifecycle`, `api-snapshot-lifecycle`, and `api-snapshot-list`.

## 2. TypeScript SDK Functional Tests

The functional suite exercises the TypeScript SDK client against a live server. It is separate from the default `pnpm test` run (which is offline-only) and uses `vitest.functional.config.ts`.

The suite includes a production-host guard that fails fast if `AMIKA_API_URL` points at the production host.

```bash
AMIKA_API_URL=https://app.staging-amika.dev/ \
AMIKA_API_TOKEN=<your-api-key> \
  pnpm --dir sdk/typescript test:functional -- --reporter=verbose
```

Pass `--reporter=verbose` so vitest prints each test as it completes instead of buffering all output until the run finishes. This makes it clear which test is running — useful because `sandbox.functional.test.ts` provisions a real sandbox on staging and can take several minutes (the suite's timeout is 15 minutes).

Individual test files:

| File | What it covers |
|---|---|
| `sandbox.functional.test.ts` | Sandbox create / list / delete lifecycle |
| `secrets.functional.test.ts` | Secret create / update / list, provider secrets |
| `release.functional.test.ts` | Release pipeline read operations |

**Expected result:** all tests pass (some may be skipped if the account lacks the relevant resources).

## Running both suites together

```bash
API_KEY=<your-api-key>
STAGING=https://app.staging-amika.dev/

# Go e2e
AMIKA_RUN_E2E=1 AMIKA_RUN_E2E_API=1 \
AMIKA_API_URL="$STAGING" AMIKA_API_KEY="$API_KEY" \
  make test-e2e-api

# TypeScript SDK functional
AMIKA_API_URL="$STAGING" AMIKA_API_TOKEN="$API_KEY" \
  pnpm --dir sdk/typescript test:functional -- --reporter=verbose
```

## Saving results

Redirect output to `scratch/test-results/` for comparison across runs:

```bash
API_KEY=<your-api-key>
STAGING=https://app.staging-amika.dev/

AMIKA_RUN_E2E=1 AMIKA_RUN_E2E_API=1 \
AMIKA_API_URL="$STAGING" AMIKA_API_KEY="$API_KEY" \
  go -C go test -v -timeout 20m ./test/e2e/... \
  2>&1 | tee scratch/test-results/e2e-go.txt

AMIKA_API_URL="$STAGING" AMIKA_API_TOKEN="$API_KEY" \
  pnpm --dir sdk/typescript test:functional -- --reporter=verbose \
  2>&1 | tee scratch/test-results/ts-sdk-functional.txt
```

## After staging passes

Promote the release and re-run if desired against production (`https://app.amika.dev/`), omitting `AMIKA_RUN_E2E_API=1` if you want to avoid creating billable resources:

```bash
AMIKA_RUN_E2E=1 \
AMIKA_API_URL=https://app.amika.dev/ \
AMIKA_API_KEY=<your-api-key> \
  make test-e2e
```

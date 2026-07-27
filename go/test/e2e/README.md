# E2E test runner

A black-box test runner for the `amika` CLI. It runs the compiled
`dist/amika` binary as a subprocess and asserts on
`argv + stdin + env -> stdout + stderr + exit code`. Nothing here calls
into Go packages that implement `amika` — every case is exactly what a
user typing commands at a shell would see.

## Running it

```bash
# From the repo root:
make test-e2e

# Or directly:
AMIKA_RUN_E2E=1 go -C go test ./test/e2e/...

# Unit tests for the runner itself (matcher, ledger, JSONPath, templating)
# need no env var, no CLI build, no network, and no Docker:
go -C go test ./test/e2e/runner/...
```

`TestE2ECases` (in `e2e_test.go`) is skipped unless `AMIKA_RUN_E2E=1`,
because some cases may reach a real API or Docker daemon. It builds
`amika` fresh via `testutil.BuildAmikaBinary`, discovers every
`cases/*.yaml`, and runs each file as a subtest.

## Directory layout

```
go/test/e2e/
  runner/         the runner package (case loading, matching, ledger, schema)
  e2e_test.go     Go test entry point, gated by AMIKA_RUN_E2E=1
  cases/          case files, one YAML document per file
  testdata/
    openapi.json  OpenAPI doc used to resolve expect.schema names
  .runs/          per-invocation run directories (gitignored, created at test time)
```

Each run writes to `go/test/e2e/.runs/<run-id>/<case-name>/`:

- `ledger.json` — every resource the case registered, appended and
  flushed to disk immediately after each registration (see below).
- `steps/NN-<slugified-step-name>.{stdout,stderr,exit}` — a full
  transcript of each step, written whether the step passed or failed.
- `state/` — an empty, isolated directory passed to every step as
  `AMIKA_STATE_DIRECTORY`, so a case never reads or writes the invoking
  user's real `~/.local/state/amika`.
- `cleanup-results.json` — written after cleanup runs (see below).

## Case file format

A case file is one YAML document with a top-level `name` and an ordered
list of `steps`:

```yaml
name: create and delete a remote sandbox
steps:
  - name: create remote sandbox
    cmd: [sandbox, create, --preset, claude, -o, json]   # argv, NOT including "amika" itself
    stdin: "optional string piped to the process's stdin"
    env:
      SOME_VAR: some-value                                # extra env for this step only
    expect:
      exit: 0                                              # optional, defaults to 0
      stdout_json:                                          # optional: match stdout parsed as JSON
        name: "@string"
        state: "@oneof: active, running, started"
      stdout_contains: "substring"                          # optional
      stderr_contains: "substring"                          # optional
      schema: "SandboxResponse"                             # optional: components.schemas.<name>
    capture:                                                # optional: extract vars for later steps
      sandbox_name: $.name
    resource:                                               # optional: register for cleanup
      type: sandbox
      name: "{{sandbox_name}}"
      cleanup: [sandbox, delete, "{{sandbox_name}}", --force, -o, json]
```

Every field except `name` and `cmd` is optional on a step. `name` is
required at both the case and step level; every step needs a non-empty
`cmd`. `LoadCase` validates this before running anything.

### Variable substitution

Any `{{var}}` placeholder in `cmd`, `stdin`, `env` values, `resource.name`,
`resource.cleanup`, `expect.stdout_contains`, `expect.stderr_contains`, and
(recursively, through nested maps/lists) `expect.stdout_json` is replaced
with a previously `capture`d value. Referencing a variable that was never
captured is an error — the step fails immediately rather than sending a
literal `{{typo}}` to the CLI.

### Capture: a minimal JSONPath

`capture` extracts values from a step's stdout, parsed as JSON, into named
variables using a deliberately small JSONPath-like syntax (see
`ExtractJSONPath` in `runner/jsonpath.go`):

| Form | Meaning |
|---|---|
| `$.field` | field access on an object |
| `$.a.b` | chained field access |
| `$[0]` | index into an array at the root |
| `$.items[0].name` | field, then index, then field |

That is the entire supported grammar: no wildcards, filters, slices, or
recursive descent (`$..foo`). If a case needs more than this, prefer
adding another explicit `capture` entry over trying to express something
cleverer in one path expression.

## Matchers (`expect.stdout_json`)

`stdout_json` is matched against stdout (parsed as JSON) using `Match` in
`runner/matcher.go`:

- A plain scalar (string/number/bool/null) in the expected value must
  equal the actual value exactly. A YAML integer compares equal to a JSON
  float64 of the same value.
- A **map** in the expected value matches actual as a **subset**: only
  the keys present in `expected` are asserted; any other keys in `actual`
  are ignored. This is what lets a case assert just the fields it cares
  about instead of enumerating a command's entire response shape.
- An **array** in the expected value matches **positionally**: actual
  must have at least as many elements as expected, and only the first
  `len(expected)` elements are compared (extra trailing elements in
  actual are ignored).
- A string in the expected value that starts with `@` is a matcher
  placeholder instead of a literal value:

  | Placeholder | Meaning |
  |---|---|
  | `@string`, `@number`, `@bool`, `@array`, `@object` | actual must be that JSON type |
  | `@string?` (any of the above `+ "?"`) | same type check, but also accepts the key being **absent** from the object entirely, or present with JSON `null` |
  | `` `@oneof: a, b, c` `` | actual, stringified, must equal one of the comma-separated tokens (trimmed, compared as strings) |
  | `@timestamp` | actual must be an RFC3339 string (with or without fractional seconds) |
  | `` `@regex: ^sb-[a-z0-9]+$` `` | actual must be a string matching the Go regexp |

On mismatch, `Match` returns one error listing every mismatching path, one
per line, e.g.:

```
$.ports[0].host_port: expected @number, got string
$.name: missing key "name"
```

## `expect.schema`: validating against the OpenAPI doc

`expect.schema: SandboxResponse` validates stdout (parsed as JSON) against
`components.schemas.SandboxResponse` in `testdata/openapi.json`, using
`github.com/santhosh-tekuri/jsonschema/v6`. Internal `$ref`s within the
document resolve normally.

Loading the OpenAPI document is deliberately best-effort: if the document
fails to parse, `Validate` returns a clear "openapi document unavailable"
error rather than panicking, so a broken or stale doc doesn't take down
every case that doesn't use `expect.schema`. If a named schema doesn't
exist under `components.schemas`, `Validate` says so explicitly rather
than silently passing.

## Resources and cleanup

A step that creates something persistent (a sandbox, a volume, ...)
declares a `resource` block naming the resource and the argv that deletes
it. The runner appends this to the run's ledger (`ledger.json`) and
**flushes it to disk immediately** — so if a later step in the same case
crashes the test process outright, the resource is still recorded on
disk and can be cleaned up by hand or by a future run.

`e2e_test.go` registers `t.Cleanup` for every case *before* running it, so
cleanup always fires, even if the case fails partway through. Cleanup
replays the ledger in **reverse** registration order (last-created
resources are deleted first) and keeps going even if one cleanup command
fails, logging the failure via `t.Log` and recording it in
`cleanup-results.json`.

To reap a run that crashed hard enough to skip `t.Cleanup` entirely (e.g.
the test process was killed), point `runner.CleanupFromLedgerFile` at that
run's leftover `ledger.json`:

```go
results, err := runner.CleanupFromLedgerFile(binPath, "/path/to/.runs/<run-id>/<case>/ledger.json", nil)
```

## Writing a real-API case (not included yet)

The two sample cases under `cases/` (`offline-cli-basics.yaml`,
`offline-output-flag.yaml`) are 100% offline: no Docker daemon, no
network, no `AMIKA_API_URL` credentials. They prove the harness works
without depending on any of that.

A case that talks to the real remote API or spins up a Docker sandbox
needs credentials/Docker available in the environment the test runs in,
so it should **not** live under `cases/` yet — a case file there is
assumed runnable by anyone with `AMIKA_RUN_E2E=1` set, nothing else.
When real-API cases are added (a later phase), name them so they are easy
to filter out or gate separately, for example:

```yaml
# cases/api-sandbox-lifecycle.yaml  (NOT included — illustrative only)
name: create and delete a remote sandbox via the real API
steps:
  - name: create remote sandbox
    cmd: [sandbox, create, --preset, claude, -o, json]
    expect:
      exit: 0
      schema: Sandbox
    capture:
      sandbox_name: $.name
    resource:
      type: sandbox
      name: "{{sandbox_name}}"
      cleanup: [sandbox, delete, "{{sandbox_name}}", --force, -o, json]

  - name: delete it explicitly to check the response shape
    cmd: [sandbox, delete, "{{sandbox_name}}", --force, -o, json]
    expect:
      exit: 0
```

A convention worth adopting once that phase starts: prefix such files
(`api-*.yaml`) and have the Go test entry point skip that prefix unless
another env var (e.g. `AMIKA_RUN_E2E_API=1`) is also set, so `AMIKA_RUN_E2E=1`
alone stays safe to run anywhere.

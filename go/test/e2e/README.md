# E2E test runner

A black-box test runner for the `amika` CLI. It runs the compiled
`dist/amika` binary as a subprocess and asserts on
`argv + stdin + env -> stdout + stderr + exit code`. Nothing here calls
into Go packages that implement `amika`; every case is exactly what a
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
  .runs/          per-invocation run directories (gitignored, created at test time)
```

The OpenAPI document used to resolve `expect.schema` names is not checked in.
It is fetched at run time from `AMIKA_E2E_OPENAPI_URL`, defaulting to
`https://app.amika.dev/api/openapi.json`, so schema assertions track the
deployed API spec (see the schema section below).

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
      stdout_not_contains: "substring"                      # optional
      stderr_contains: "substring"                          # optional
      stderr_not_contains: "substring"                      # optional
      schema: "SandboxResponse"                             # optional: components.schemas.<name>
    capture:                                                # optional: extract vars for later steps
      sandbox_name: $.name
    resource:                                               # optional: register for cleanup
      type: sandbox
      name: "{{sandbox_name}}"
      cleanup: [sandbox, delete, "{{sandbox_name}}", --force, -o, json]
      register_on_failure: false                            # optional: set true to register even on an unexpected exit (default false)
    release_resource:                                      # optional: retire a consumed resource after this step passes
      type: sandbox
      name: "{{sandbox_name}}"
```

Every field except `name` and `cmd` is optional on a step. `name` is
required at both the case and step level; every step needs a non-empty
`cmd`. `LoadCase` validates this before running anything.

`release_resource` removes a matching prior `resource` entry from the cleanup
ledger only after the command and every assertion succeed. Use it when the
operation under test consumes a resource, such as `snapshot create --mode
scrub_and_delete` deleting its source sandbox. If the step fails, the ledger
entry remains available for best-effort cleanup.

### Variable substitution

One variable is predefined: `{{run_id}}`, a timestamp unique to the whole
run. A case that creates a **named** remote resource should build the name
from it (`--name e2e-ssh-key-{{run_id}}`). Names are frequently upserted
rather than rejected, so a fixed name lets a case adopt, mutate, and then
delete a resource the account already had, and lets two concurrent runs
sharing an account clobber each other.

Any `{{var}}` placeholder in `cmd`, `stdin`, `env` values, `resource.name`,
`resource.cleanup`, `release_resource.type`, `release_resource.name`,
`expect.stdout_contains`, `expect.stdout_not_contains`,
`expect.stderr_contains`, `expect.stderr_not_contains`, and
(recursively, through nested maps/lists) `expect.stdout_json` is replaced
with a previously `capture`d value. Referencing a variable that was never
captured is an error: the step fails immediately rather than sending a
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
- An **array** in the expected value matches **positionally**, and by
  default the lengths must match **exactly**: actual must have the same
  number of elements as expected. Two opt-ins relax or fill this:
  - End the expected array with `"@..."` to match only a **prefix**: the
    elements before it are matched positionally and any number of further
    elements in actual are allowed and left unchecked. Use this to assert
    the first `m` elements of a longer array.
  - Use `"@any"` as an element to assert a position is **present** without
    checking its value, e.g. `["2", "3", "@any", "5"]`.
- A string in the expected value that starts with `@` is a matcher
  placeholder instead of a literal value:

  | Placeholder | Meaning |
  |---|---|
  | `@string`, `@number`, `@bool`, `@array`, `@object` | actual must be that JSON type |
  | `@string?` (any of the above `+ "?"`) | same type check, but also accepts the key being **absent** from the object entirely, or present with JSON `null` |
  | `@any` | matches any value in that position (any type, including `null`); a placeholder to skip a single array element or key |
  | `@...` | final element of an expected array only: allows any number of further unchecked elements after the matched prefix |
  | `` `@oneof: a, b, c` `` | actual, stringified, must equal one of the comma-separated tokens (trimmed, compared as strings) |
  | `@timestamp` | actual must be an RFC3339 string (with or without fractional seconds) |
  | `` `@regex: ^sb-[a-z0-9]+$` `` | actual must be a string matching the Go regexp |

  An optional placeholder (`@string?`) whose base name is not a real
  matcher (e.g. a typo like `@strng?`) is rejected rather than silently
  treated as "absent is fine", so a misspelling cannot mask a missing key.

On mismatch, `Match` returns one error listing every mismatching path, one
per line, e.g.:

```
$.ports[0].host_port: expected @number, got string
$.name: missing key "name"
```

## `expect.schema`: validating against the OpenAPI doc

`expect.schema: SandboxResponse` validates stdout (parsed as JSON) against
`components.schemas.SandboxResponse` in the OpenAPI document, using
`github.com/santhosh-tekuri/jsonschema/v6`. Internal `$ref`s within the
document resolve normally.

The OpenAPI document is **not checked into the repo**. It is fetched at run
time from the URL in `AMIKA_E2E_OPENAPI_URL`, defaulting to
`https://app.amika.dev/api/openapi.json`, so schema assertions validate
against the currently deployed spec rather than a copy that can drift. The
value may also be a local filesystem path if you want to validate against a
spec you have on disk.

The document is fetched **lazily**, the first time a case actually uses
`expect.schema`. A run whose cases never request schema validation (such as
the offline sample cases) does no network I/O for the schema at all, so the
default URL never forces a run to touch the network.

Loading the OpenAPI document is deliberately best-effort: if the document
cannot be fetched or fails to parse, `Validate` returns a clear "openapi
document unavailable" error rather than panicking, so a broken, stale, or
unreachable doc doesn't take down every case that doesn't use
`expect.schema`. If a named schema doesn't exist under `components.schemas`,
`Validate` says so explicitly rather than silently passing.

## Resources and cleanup

A step that creates something persistent (a sandbox, a volume, ...)
declares a `resource` block naming the resource and the argv that deletes
it. The runner appends this to the run's ledger (`ledger.json`) and
**flushes it to disk immediately**, so if a later step in the same case
crashes the test process outright, the resource is still recorded on
disk and can be cleaned up by hand or by a future run.

A resource is registered when its step exits as expected, even if a later
capture or content assertion in that same step then fails, so a resource
that was really created is never orphaned. When the step exits with an
**unexpected** status the outcome is ambiguous (the command may have failed
before creating anything, such as a name collision), so the resource is
registered only if the block sets `register_on_failure: true`. Leave that
off unless the command is known to create the resource before it can fail;
otherwise cleanup could delete a pre-existing resource this run does not
own.

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

## Offline cases vs. real-API cases

Case files fall into two tiers, distinguished by filename:

- **Offline cases** (any name without the `api-` prefix) are 100% offline:
  no Docker daemon, no network, no credentials. They cover flag validation,
  `-o json` rejections, argument errors, and `--help`. They run with
  `AMIKA_RUN_E2E=1` alone and are safe anywhere.
- **Real-API cases** (`api-*.yaml`) talk to the real remote API at
  `AMIKA_API_URL` and may create billable resources. The Go test entry point
  **skips** them unless `AMIKA_RUN_E2E_API=1` is *also* set, so plain
  `AMIKA_RUN_E2E=1` never reaches the network or spends money.

```bash
make test-e2e       # offline cases only (api-*.yaml are skipped)
make test-e2e-api   # offline + real-API cases (needs AMIKA_API_KEY/AMIKA_API_URL)
```

Real-API cases that create something must declare a `resource` block so the
ledger can delete it afterward (see "Resources and cleanup" above). A
read-only real-API case (e.g. `sandbox list`) needs no `resource`. Example:

```yaml
# cases/api-sandbox-lifecycle.yaml
name: create and delete a remote sandbox via the real API
steps:
  - name: create remote sandbox
    cmd: [sandbox, create, --remote, --preset, claude, -o, json]
    expect:
      exit: 0
      schema: Sandbox
    capture:
      sandbox_name: $.name
    resource:
      type: sandbox
      name: "{{sandbox_name}}"
      cleanup: [sandbox, delete, "{{sandbox_name}}", --force, -o, json]
```

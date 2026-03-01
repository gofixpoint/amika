# Development Testing

This guide is the binary-focused integration smoke plan to confirm Amika still works end-to-end after changes.

## Testing Plan

Run tests in this order so failures are easier to isolate:

1. Build and command smoke checks.
2. `auth` smoke checks.
3. `materialize` end-to-end with `materialization-scripts/random-tree.py`.
4. `sandbox` lifecycle end-to-end (Docker required).
5. Optional preset integration check.
6. Full automated suite (`go test ./...`).

Pass criteria:

- All commands exit with code `0`.
- `materialize` produces output files in `destdir`.
- `sandbox create/list/delete` shows expected lifecycle behavior.
- `go test ./...` passes.

If a step fails, capture:

- exact command run
- exit code
- stderr/stdout output
- environment notes (Docker running, host OS, relevant env vars)

## Build

```bash
go build -o dist/amika ./cmd/amika
```

## Command Smoke Checks

These should all succeed and print help/usage information:

```bash
./dist/amika --help
./dist/amika sandbox --help
./dist/amika materialize --help
./dist/amika auth --help
./dist/amika auth extract --help
```

## Auth Smoke Check

Run auth extract in both modes to verify command execution path:

```bash
./dist/amika auth extract
./dist/amika auth extract --export
```

## Materialize End-to-End (Project Script)

Use the repository script `materialization-scripts/random-tree.py`:

```bash
tmp="$(mktemp -d)"

./dist/amika materialize \
  --script ./materialization-scripts/random-tree.py \
  --destdir "$tmp/out" -- .
```

Verify files were materialized:

```bash
find "$tmp/out" -maxdepth 3 -type f | head
```

## Sandbox Lifecycle End-to-End (Docker Required)

```bash
./dist/amika sandbox create --name amika-smoke --yes
./dist/amika sandbox list | grep amika-smoke
./dist/amika sandbox connect amika-smoke
./dist/amika sandbox delete amika-smoke
```

## Optional Materialize + Preset Check

```bash
tmp="$(mktemp -d)"
./dist/amika materialize --preset coder --cmd "echo ok > smoke.txt" --destdir "$tmp/out"
cat "$tmp/out/smoke.txt"
```

Expected output:

```text
ok
```

## Automated Test Suite

Run the full Go test suite after smoke checks:

```bash
go test ./...
```

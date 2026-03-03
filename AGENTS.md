# AGENTS.md

This file provides guidance to AI coding agents when working with code in this repository.

## Build and Development Commands

**Always use `make build` to build the project.** If you run `go build` directly, you must output to `dist/`:

```bash
go build -o dist/amika ./cmd/amika
```

```bash
# Set up git hooks (one-time after clone)
make setup

# Run all CI checks locally (fmt, vet, lint, build, test)
make ci

# Individual targets
make build   # go build -o dist/amika ./cmd/amika
make test    # go test ./...
make vet     # go vet ./...
make fmt     # check formatting
make lint    # run revive linter
```

## Project Overview

Amika is a Go CLI tool. The project uses standard Go tooling with a Makefile for common commands.

## Code Structure

- `cmd/amika/main.go` - Main entry point for the CLI
- `dist/` - Build output directory (gitignored)
- `bin/amika` - Wrapper script that auto-builds and runs dist/amika

## Development Notes

- Requires Go 1.21 or later
- Linting uses [revive](https://github.com/mgechev/revive) — config in `revive.toml`
- All exported symbols must have doc comments (enforced by the `exported` rule)
- No external dependencies need to be installed for linting; `make lint` uses `go run`

## Cursor Cloud specific instructions

- **Docker is required** for `materialize`, `sandbox`, and `volume` commands. Docker must be started before running integration tests or the CLI end-to-end. Start it with `sudo dockerd &>/tmp/dockerd.log &` and ensure the socket is accessible (`sudo chmod 666 /var/run/docker.sock`).
- **rsync is required** by `materialize` and overlay mount operations.
- **Git URL rewriting caveat:** The Cloud Agent environment has global git `url.*.insteadOf` rules that inject auth tokens into GitHub URLs. Two tests (`TestPrepareGitMount_CleanClone`, `TestSyncGitRemotes`) will fail unless you override this. Run tests with `GIT_CONFIG_GLOBAL=/dev/null make test` or `GIT_CONFIG_GLOBAL=/dev/null make ci` to avoid false failures.
- **Running the CLI:** After `make build`, the binary is at `dist/amika`. See `docs/development/testing.md` for the full smoke test plan.

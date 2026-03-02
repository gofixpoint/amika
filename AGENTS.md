# AGENTS.md

This file provides guidance to AI coding agents when working with code in this repository.

## Build and Development Commands

**Use `make build` to build both binaries, or `make build-cli` / `make build-server` for one binary.** If you run `go build` directly, you must output to `dist/`:

```bash
go build -o dist/amika ./cmd/amika
go build -o dist/amika-server ./cmd/amika-server
```

```bash
# Set up git hooks (one-time after clone)
make setup

# Run all CI checks locally (fmt, vet, lint, build, test)
make ci

# Individual targets
make build         # builds both dist/amika and dist/amika-server
make build-cli     # go build -o dist/amika ./cmd/amika
make build-server  # go build -o dist/amika-server ./cmd/amika-server
make test    # go test ./...
make vet     # go vet ./...
make fmt     # check formatting
make lint    # run revive linter
```

## Project Overview

Amika is a Go CLI tool. The project uses standard Go tooling with a Makefile for common commands.

## Code Structure

- `cmd/amika/main.go` - Main entry point for the CLI
- `cmd/amika-server/main.go` - Main entry point for the HTTP server
- `dist/` - Build output directory (gitignored)
- `bin/amika` - Wrapper script that auto-builds and runs dist/amika
- `bin/amika-server` - Wrapper script that auto-builds and runs dist/amika-server

## Development Notes

- Requires Go 1.21 or later
- Linting uses [revive](https://github.com/mgechev/revive) — config in `revive.toml`
- All exported symbols must have doc comments (enforced by the `exported` rule)
- No external dependencies need to be installed for linting; `make lint` uses `go run`

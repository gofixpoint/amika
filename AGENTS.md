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

Amika is a Go module that lets people control sandboxed AI agents, focused on use-cases for AI coding agents. The goal is to provide the infra for users to build their own software factories. It includes a CLI tool `amika`, a Go package `pkg/amika

 CLI tool that materializes data from external sources and mounts it into Docker-backed sandboxes for AI coding agents. It also includes an HTTP server (`amika-server`) that exposes the same functionality as a REST API. The project uses standard Go tooling with a Makefile for common commands.

## Runtime Dependencies

- **Docker** is required for `materialize`, `sandbox`, and `volume` commands. Preset images (`coder`, `claude`) are auto-built on first use from Dockerfiles in `internal/sandbox/presets/`.
- **rsync** is required by the `materialize` command to copy output files.

## Code Structure

### CLI Commands (`cmd/amika/`)
- `main.go` — Entry point, root Cobra command
- `sandbox.go` — `sandbox create|list|connect|delete` commands
- `materialize.go` — `materialize` command (Docker-based)
- `volume.go` — `volume list|delete` commands
- `auth.go` — `auth extract` command

### HTTP Server (`cmd/amika-server/`)
- `main.go` — Entry point for the HTTP server (listens on `:8080` by default)

### Internal Packages (`internal/`)
- `sandbox/` — Docker sandbox management, preset image resolution + auto-build, volume and file mount stores, random name generation
- `auth/` — Multi-source credential discovery (Claude, Codex, OpenCode, Amp) with priority-based deduplication
- `agentconfig/` — Discovers agent credential files on host and produces mount specs for containers (auto-mounted into every sandbox and materialize container)
- `config/` — XDG path resolution, state file location helpers
- `basedir/` — XDG base directory resolution
- `httpapi/` — HTTP handler for the REST API server
- `app/` — Application service layer implementation
- `ports/` — Port interfaces for Docker and store operations
- `materialize/` — Local sandbox script execution and rsync copying (v0 legacy)

### Public Package (`pkg/amika/`)
- `service.go` — Public service API used by both the CLI and HTTP server
- `requests.go` — Request types
- `responses.go` — Response types

### Other
- `dist/` — Build output directory (gitignored)
- `bin/amika` — Wrapper script that auto-builds and runs `dist/amika`
- `bin/amika-server` — Wrapper script that auto-builds and runs `dist/amika-server`
- `materialization-scripts/` — Example data materialization scripts
- `internal/sandbox/presets/` — Dockerfiles for `coder` and `claude` presets

## Development Notes

- Requires Go 1.21 or later
- Linting uses [revive](https://github.com/mgechev/revive) — config in `revive.toml`
- All exported symbols must have doc comments (enforced by the `exported` rule)
- No external dependencies need to be installed for linting; `make lint` uses `go run`

## Testing Notes

- Docker must be running for integration tests and CLI end-to-end testing
- Test targets: `make test-unit`, `make test-integration`, `make test-contract`, `make test-expensive`
- Some tests are skipped by default. Run expensive Docker tests with: `AMIKA_RUN_EXPENSIVE_TESTS=1 make test-expensive`
- See `docs/development/testing.md` for the full smoke test plan

## Environment Variables

| Variable | Purpose |
|----------|---------|
| `AMIKA_STATE_DIRECTORY` | Override default state directory (`~/.local/state/amika`) |
| `AMIKA_PRESET_IMAGE_PREFIX` | Override Docker image name prefix for presets |
| `AMIKA_RUN_EXPENSIVE_TESTS` | Set to `1` to enable expensive Docker integration tests |
| `PORT` | Override listen address for `amika-server` (mutually exclusive with `-addr` flag) |

## Cursor Cloud specific instructions

See [AGENTS.cursor.md](AGENTS.cursor.md).

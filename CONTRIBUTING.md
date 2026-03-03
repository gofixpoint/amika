# Contributing

## Prerequisites

- Go 1.21 or later
- Docker (required for `materialize`, `sandbox`, and `volume` commands)
- macOS (the only supported platform currently)
- rsync (usually pre-installed on macOS)

## Setup

After cloning, configure git hooks:

```bash
git clone https://github.com/gofixpoint/amika.git && cd amika
make setup
```

## Building

```bash
# Build both binaries (recommended)
make build

# Or build individually
make build-cli     # go build -o dist/amika ./cmd/amika
make build-server  # go build -o dist/amika-server ./cmd/amika-server
```

The wrapper scripts auto-build and run for convenience during development:

```bash
bin/amika --help
bin/amika-server
```

## Running

```bash
dist/amika
dist/amika-server
```

## Development

```bash
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

Linting uses [revive](https://github.com/mgechev/revive) with config in `revive.toml`. All exported symbols must have doc comments (enforced by the `exported` rule). No external tools need to be installed — `make lint` uses `go run`.

## Testing

Run the full test suite:

```bash
make test
```

Individual test targets:

```bash
make test-unit          # Unit tests (excludes integration/contract)
make test-integration   # Integration tests
make test-contract      # Contract tests
make test-expensive     # All tests including Docker rebuilds
```

For end-to-end smoke tests (Docker required), see [docs/development/testing.md](docs/development/testing.md).

## Project Structure

```
cmd/amika/               CLI commands (Cobra)
cmd/amika-server/        HTTP server entry point
internal/
  sandbox/               Docker sandbox management, presets, volumes
  auth/                  Credential discovery (Claude, Codex, OpenCode, Amp)
  agentconfig/           Auto-mount agent credential files into containers
  config/                XDG path resolution, state file locations
  basedir/               XDG base directory resolution
  httpapi/               HTTP handler for the REST API
  app/                   Application service layer
  ports/                 Port interfaces for Docker and stores
  mount/                 bindfs-based mount/unmount (v0 legacy)
  materialize/           Local sandbox script execution (v0 legacy)
  state/                 JSONL mount state persistence (v0 legacy)
pkg/amika/               Public service API (used by CLI and HTTP server)
materialization-scripts/ Example scripts for pulling data
docs/                    In-depth documentation
```

## Preset Images

The `coder` and `claude` preset Docker images are auto-built on first use from Dockerfiles in `internal/sandbox/presets/`. See [docs/presets.md](docs/presets.md) for details.

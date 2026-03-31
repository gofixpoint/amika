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
  materialize/           Local sandbox script execution (v0 legacy)
pkg/amika/               Public service API (used by CLI and HTTP server)
materialization-scripts/ Example scripts for pulling data
docs/                    In-depth documentation
```

## Preset Images

The `coder` and `claude` preset Docker images are auto-built on first use from Dockerfiles in `internal/sandbox/presets/`. See [docs/presets.md](docs/presets.md) for details.

## Releasing

Releases are cut via the **Create Release Tag** workflow (`release-tag.yml`), triggered manually from the Actions tab. It creates an annotated tag which automatically triggers the **Release** workflow (`release.yml`) to build cross-platform binaries and publish a GitHub Release.

### Releasing from main HEAD (default)

Leave the **ref** field empty. The tag is placed on the latest `main` commit.

### Releasing from a specific commit or tag

Enter a commit SHA, short SHA, or existing tag name in the **ref** field. The commit must be an ancestor of (or equal to) `main`.

### Releasing from a release branch

For long-lived release branches (e.g. `release/1.x`), the branch must first be added to `.github/release-branches.json` on `main`:

```json
{
  "branches": [
    "release/1.x"
  ]
}
```

Changes to this file require approval from `@gofixpoint/releasers` (enforced via CODEOWNERS). Once approved, enter the branch name (or a commit SHA on that branch) in the **ref** field.

The allowlist is always read from `main` to prevent a release branch from approving itself.

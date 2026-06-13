# AGENTS.md

This file provides guidance to AI coding agents when working with code in this repository.

## Build and Development Commands

All Go sources live under `go/`. The Makefile at the repo root runs go
commands with `go -C go ...`, so `make` targets continue to work
unchanged from the repo root. Build outputs are written to `dist/` at
the repo root.

**Use `make build` to build all binaries (`amika`, `amika-server`, `amikalog`, and the experimental `akfs`), or `make build-cli` / `make build-server` / `make build-amikalog` / `make build-akfs` for one binary.** If you run `go build` directly, do it from the `go/` directory and write outputs to the repo-root `dist/`:

```bash
(cd go && go build -o ../dist/amika ./cmd/amika)
(cd go && go build -o ../dist/amika-server ./cmd/amika-server)
(cd go && go build -o ../dist/amikalog ./cmd/amikalog)
```

```bash
# Set up git hooks (one-time after clone)
make setup

# Run all CI checks locally (fmt, vet, lint, build, test)
make ci

# Individual targets
make build          # builds dist/amika, dist/amika-server, dist/amikalog, dist/akfs
make build-cli      # builds dist/amika
make build-server   # builds dist/amika-server
make build-amikalog # builds dist/amikalog
make build-akfs     # builds dist/akfs (experimental, labs)
make test    # go test ./... (run from go/)
make vet     # go vet ./...  (run from go/)
make fmt     # check formatting
make lint    # run revive linter
```

## Project Overview

Amika is a Go module that lets people control sandboxed AI agents, focused on use-cases for AI coding agents. The goal is to provide the infra for users to build their own software factories. It includes a CLI tool `amika`, a Go package `go/pkg/amika`, and an HTTP server (`amika-server`) that exposes the same functionality as a REST API. The project uses standard Go tooling with a Makefile for common commands.

The repo also ships `amikalog`, a separate, separately-installed CLI that captures Claude Code and Codex hook activity (with the git state of each hook's working directory) as raw append-only events under the amika state directory. Run `amikalog start` once to install the hooks. It is versioned and released independently of `amika` (tags `amikalog@v*`).

This repository is an OSS monorepo. Go sources live under `go/`. Other
language SDKs live under `sdk/` (e.g. `sdk/typescript/`).

## Runtime Dependencies

- **Docker** is required for `materialize`, `sandbox`, and `volume` commands. Preset images (`coder`, `claude`) are auto-built on first use from Dockerfiles in `go/internal/sandbox/presets/`.
- **rsync** is required by the `materialize` command to copy output files.

## Code Structure

### CLI Commands (`go/cmd/amika/`)
- `main.go` — Entry point, root Cobra command
- `sandbox.go` — `sandbox create|list|connect|delete` commands
- `materialize.go` — `materialize` command (Docker-based)
- `volume.go` — `volume list|delete` commands
- `auth.go` — `auth extract` command

### HTTP Server (`go/cmd/amika-server/`)
- `main.go` — Entry point for the HTTP server (listens on `:8080` by default)

### amikalog CLI (`go/cmd/amikalog/`)
- `main.go` — Entry point, root Cobra command
- `start.go` — `start` / `stop` commands that install/remove the agent hooks
- `hook.go` — `hook --source claude|codex`, the hook entrypoint that records one event
- `push.go` — `beta:push`, uploads not-yet-pushed events to the org storage bucket (auth via `AMIKA_API_KEY` only; requests a signed upload URL per file from `POST /api/v0beta1/storage/uploads/batch`, then PUTs the bytes)
- `fetch.go` — `beta:fetch <destination>`, downloads the entire org storage bucket into a local directory, recreating the bucket key tree on disk (auth via `AMIKA_API_KEY` only; lists the bucket via `GET /api/v0beta1/storage/downloads`, paging through `next_cursor`, then GETs each object's signed download URL)

### Internal Packages (`go/internal/`)
- `sandbox/` — Docker sandbox management, preset image resolution + auto-build, volume and file mount stores, random name generation
- `auth/` — Multi-source credential discovery (Claude, Codex, OpenCode, Amp) with priority-based deduplication
- `agentconfig/` — Discovers agent credential files on host and produces mount specs for containers (auto-mounted into every sandbox and materialize container)
- `config/` — XDG path resolution, state file location helpers
- `basedir/` — XDG base directory resolution
- `httpapi/` — HTTP handler for the REST API server
- `app/` — Application service layer implementation
- `ports/` — Port interfaces for Docker and store operations
- `materialize/` — Local sandbox script execution and rsync copying (v0 legacy)
- `eventlog/` — amikalog's hook installer + capture: appends events (one JSON line each) to a per-session JSONL file `<state>/events/{claude,codex}/sessions/{ts}_{session_id}.jsonl`, annotated with git context. `push.go` uploads each changed session file in parallel via an `Uploader`, tracking each file's uploaded byte size in `<state>/events/.amikalog-push-state.json` so only sessions that grew are re-sent (object key = `<repo>/<source>/sessions/<ts>_<session_id>.jsonl`, repo from each session's `git.repo_root`; legacy per-event `event_*.json` files are still uploaded for backward compatibility)

### Public Package (`go/pkg/amika/`)
- `service.go` — Public service API used by both the CLI and HTTP server
- `requests.go` — Request types
- `responses.go` — Response types

### Labs / Experimental Code (`go/labs/`)
- Experimental, unstable code with **no compatibility guarantees**; stable code (`go/cmd/*`, `go/pkg/amika`, `go/internal/*`) must **not** import from it. Holds the `akfs` CLI (`go/labs/cmd/akfs/`) and library (`go/labs/akfs/`).
- See `go/labs/AGENTS.md` before working there.

### Other
- `dist/` — Build output directory at the repo root (gitignored)
- `bin/amika` — Wrapper script that auto-builds and runs `dist/amika`
- `bin/amika-server` — Wrapper script that auto-builds and runs `dist/amika-server`
- `bin/amikalog` — Wrapper script that auto-builds and runs `dist/amikalog`
- `materialization-scripts/` — Example data materialization scripts
- `go/internal/sandbox/presets/` — Dockerfiles for `coder` and `claude` presets
- `sdk/typescript/` — TypeScript SDK

## Development Notes

- Requires Go 1.21 or later
- Linting uses [revive](https://github.com/mgechev/revive) — config in `go/revive.toml`
- All exported symbols must have doc comments (enforced by the `exported` rule)
- No external dependencies need to be installed for linting; `make lint` uses `go run`
- Ports 60899–60999 are reserved inside sandbox containers for Amika services. See `docs/sandbox-configuration.md` for the allocation table.

## Documentation Style

For user-facing docs (`docs/`, README):

- Lead with the value prop: what the problem is and why it matters, then the solution, then how to use it. Reference tables (commands, env vars, schemas) come after the narrative, not instead of it.
- Only document commands and behavior that exist in the current code — verify against the `go/cmd/` sources. Don't import claims from marketing material describing future features.
- No mid-sentence em-dashes in running prose; the `**Term** — description` separator in bullet lists is fine.
- Use the `naive-reader-review` skill to pressure-test a doc with a cold reader.

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
| `AMIKA_API_URL` | Override remote API base URL (default: `https://app.amika.dev`) |
| `AMIKA_WORKOS_CLIENT_ID` | Override default WorkOS client ID for `amika auth login` |
| `AMIKA_RUN_EXPENSIVE_TESTS` | Set to `1` to enable expensive Docker integration tests |
| `PORT` | Override listen address for `amika-server` (mutually exclusive with `-addr` flag) |

## Cursor Cloud specific instructions

See [AGENTS.cursor.md](AGENTS.cursor.md).

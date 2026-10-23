# AGENTS.md

This file provides guidance to AI coding agents when working with code in this repository.

## Build and Development Commands

All Go sources live under `go/`. The Makefile at the repo root runs go
commands with `go -C go ...`, so `make` targets continue to work
unchanged from the repo root. Build outputs are written to `dist/` at
the repo root.

**Use `make build` to build all binaries (`amika`, `amikad`, `amikalog`, and the experimental `akfs` and `amikalyze`), or `make build-cli` / `make build-amikad` / `make build-amikalog` / `make build-akfs` / `make build-amikalyze` for one binary.** If you run `go build` directly, do it from the `go/` directory and write outputs to the repo-root `dist/`:

```bash
(cd go && go build -o ../dist/amika ./cmd/amika)
(cd go && go build -o ../dist/amikalog ./cmd/amikalog)
```

```bash
# Set up git hooks (one-time after clone)
make setup

# Run all CI checks locally (fmt, vet, lint, build, test)
make ci

# Individual targets
make build          # builds all stable and experimental binaries
make build-cli      # builds dist/amika
make build-amikalog # builds dist/amikalog
make build-akfs     # builds dist/akfs (experimental, labs)
make build-amikalyze # builds dist/amikalyze (experimental, labs)
make test    # go test ./... (run from go/)
make vet     # go vet ./...  (run from go/)
make fmt     # check formatting
make lint    # run revive linter
make zizmor  # audit GitHub Actions workflows with zizmor (needs uv)
```

## Project Overview

Amika is a Go module that lets people control sandboxed AI agents, focused on use-cases for AI coding agents. The goal is to provide the infra for users to build their own software factories. It includes a CLI tool `amika` and a Go package `go/pkg/amika`. The project uses standard Go tooling with a Makefile for common commands.

The repo also ships `amikalog`, a separate, separately-installed CLI that captures Claude Code and Codex hook activity (with the git state of each hook's working directory) as raw append-only events under the amika state directory. Run `amikalog start` once to install the hooks. It is versioned and released independently of `amika` (tags `amikalog@v*`).

This repository is an OSS monorepo. Go sources live under `go/`. Other
language SDKs live under `sdk/` (e.g. `sdk/typescript/`). TypeScript packages
that are consumed as source rather than published live under `js/`: among them
`js/sandbox` (`@amika/sandbox`), the sandbox provider abstraction, and
`js/service-auth` (`@amika/service-auth`), who may reach a rig's service. See
[`js/AGENTS.md`](./js/AGENTS.md) for the conventions every `js/` package
follows.

There are two independent pnpm workspaces here, on purpose. The repo root
governs `js/*` and `eslint-rules` (root `pnpm-workspace.yaml` and
`pnpm-lock.yaml`); `sdk/typescript` governs itself, with its own workspace file,
lockfile, and `packageManager` pin, because it is a published npm package with
its own release pipeline. Run `pnpm install` at the root for the former and
from `sdk/typescript/` for the latter.

`js/sandbox`, and `js/service-auth` which it depends on, are consumed by
`amika-mono` as a git submodule pinned to an exact commit, so this repo is the
single source of truth for those packages: changes
land here and reach amika-mono through a pointer bump. That also means this
repo's CI and pre-commit hook own the package's source quality — amika-mono
sees only a gitlink for the submodule and so cannot lint or format it.

Comments and docstrings here sometimes point at `amika-mono`, Amika's private
control-plane monorepo, for protocol details owned by that side (e.g. "the
ssh-relay repo's specs/019-sandbox-ssh-stream-relay.d/...",
`devdocs/sandbox-secret-scrubbing.md`). This repo's own `specs/` directory is
numbered separately and covers only OSS-specific specs. Look for `amika-mono`
checked out as a sibling worktree rather than searching for those paths in this repo.

## Runtime Dependencies

- The `amika` CLI itself is remote-only: every `rig`/`sandbox` command talks to the Amika API. The former `--local` mode, and the `volume` and `materialize` commands that served it, have been removed.

## Code Structure

### CLI Commands (`go/cmd/amika/`)
Conventions for commands (help text, replacing flags, `--output`/`-o` JSON, rig arguments) live in [`go/cmd/amika/AGENTS.md`](go/cmd/amika/AGENTS.md).

- `main.go` — Entry point, root Cobra command
- `sandbox.go` — `sandbox create|list|connect|delete` commands
- `host.go` — `host list|get|delete` commands over the org's own hosts (BYOC); hosts are registered by `amika-hostd`, not here
- `auth.go` — `auth login|logout|status` commands
- `auth_api_key.go` — `auth api-key create`, which mints an API key and writes its value only to the `--out` file (never the CLI's own output, errors, or `-o json`)
- `skill.go` — `skill install --global|--local [--agents ...]`, which writes the `amika-cli` agent skill embedded in the binary into each agent's skill directory (logic in `internal/agentskill`)

### amikalog CLI (`go/cmd/amikalog/`)
- `main.go` — Entry point, root Cobra command
- `start.go` — `start` / `stop` commands that install/remove the agent hooks
- `hook.go` — `hook --source claude|codex`, the hook entrypoint that records one event
- `push.go` — `beta:push`, uploads not-yet-pushed events to the org storage bucket (auth via `AMIKA_API_KEY` only; requests a signed upload URL per file from `POST /api/v0beta1/storage/uploads/batch`, then PUTs the bytes)
- `fetch.go` — `beta:fetch <destination>`, downloads the entire org storage bucket into a local directory, recreating the bucket key tree on disk (auth via `AMIKA_API_KEY` only; lists the bucket via `GET /api/v0beta1/storage/downloads`, paging through `next_cursor`, then GETs each object's signed download URL)

### Internal Packages (`go/internal/`)
- `sandbox/` — Docker sandbox management, preset image resolution + auto-build, volume and file mount stores, random name generation
- `auth/` — Multi-source credential discovery (Claude, Codex, OpenCode, Amp) with priority-based deduplication
- `config/` — XDG path resolution, state file location helpers
- `basedir/` — XDG base directory resolution
- `app/` — Application service layer implementation
- `ports/` — Port interfaces for Docker and store operations
- `output/` — CLI output formatting for the `--output`/`-o` flag (`text`, `json`, `json-pretty`)
- `services/` — Shared sandbox-service logic used by CLI and API, e.g. `ValidatePort` (rejects out-of-range and reserved container ports)
- `rigref/` — Parses rig references (a name or id, `name=`/`id=` to pin the field, `_self` for the current rig); rules for commands that take a rig are in [`go/cmd/amika/AGENTS.md`](go/cmd/amika/AGENTS.md)
- `materialize/` — Local sandbox script execution and rsync copying (v0 legacy)
- `agentskill/` — Agent names, per-agent skill directories, and the copy behind `amika skill install`
- `eventlog/` — amikalog's hook installer, event capture, and push (details in the package doc)

### Public Package (`go/pkg/amika/`)
- `service.go` — Public service API and the request/response types the CLI uses
- `requests.go` — Request types
- `responses.go` — Response types

### Labs / Experimental Code (`go/labs/`)
- Experimental, unstable code with **no compatibility guarantees**; stable code (`go/cmd/*`, `go/pkg/amika`, `go/internal/*`) must **not** import from it. Holds the `akfs` CLI and library plus the `amikalyze` frozen-path CLI and library.
- See `go/labs/AGENTS.md` before working there.

### Other
- `dist/` — Build output directory at the repo root (gitignored)
- `bin/amika` — Wrapper script that auto-builds and runs `dist/amika`
- `bin/amikalog` — Wrapper script that auto-builds and runs `dist/amikalog`
- `bin/amikalyze` — Wrapper script that auto-builds and runs `dist/amikalyze`
- `materialization-scripts/` — Example data materialization scripts
- `sandbox-image/` — Shared manifest, build steps, assets, verification suite, and generated Dockerfiles. It also holds generated copies of the `amika-cli` skill: edit only `.agents/skills/amika-cli/`, then run `python3 sandbox-image/generate.py` (CI fails on a stale copy). The copy in the Go-embed mirror is also what `amika skill install` writes, via `sandbox.AgentSkillFS`
- `sdk/typescript/` — TypeScript SDK

## Development Notes

- Requires Go 1.26.10 or later, excluding 1.27.0–1.27.2 (`make` rejects them)
- Linting uses [revive](https://github.com/mgechev/revive) — config in `go/revive.toml`
- All exported symbols must have doc comments (enforced by the `exported` rule)
- No external dependencies need to be installed for linting; `make lint` uses `go run`
- GitHub Actions workflows are audited by [zizmor](https://docs.zizmor.sh) (`make zizmor` locally, `.github/workflows/zizmor.yml` in CI). Pin every `uses:` to a full commit SHA with a trailing `# vX.Y.Z` comment (Dependabot bumps both), declare least-privilege `permissions:`, and check out with `persist-credentials: false` unless a later step pushes. Suppress a finding that does not apply with `# zizmor: ignore[<audit>]` plus a comment saying why
- The Amika API (amika-mono's control plane) and its clients here (the CLI, the TypeScript SDK) ship together, API first. Don't add extra requests, client-side checks, or fallbacks for older servers unless asked.
- Ports 60899–60999 are reserved inside sandbox containers for Amika services. See `docs/sandbox-configuration.md` for the allocation table. Any command or API that accepts a user-specified container port must reject this range by calling `services.ValidatePort` (`go/internal/services`); keep client-side and server-side validation in sync.

## Documentation Style

For user-facing docs (`docs/`, README):

- Lead with the value prop: what the problem is and why it matters, then the solution, then how to use it. Reference tables (commands, env vars, schemas) come after the narrative, not instead of it.
- Only document commands and behavior that exist in the current code — verify against the `go/cmd/` sources. Don't import claims from marketing material describing future features.
- No mid-sentence em-dashes in running prose; the `**Term** — description` separator in bullet lists is fine.
- Use the `naive-reader-review` skill to pressure-test a doc with a cold reader.

## Testing Notes

- Docker must be running for integration tests and CLI end-to-end testing
- Test targets: `make test-unit`, `make test-integration`, `make test-contract`, `make test-expensive`
- The Docker-gated suites (`AMIKA_RUN_DOCKER_INTEGRATION`, `AMIKA_RUN_EXPENSIVE_TESTS`) currently have no tests opting into them; they were removed with the CLI's `--local` mode. See `docs/development/testing.md`
- See `docs/development/testing.md` for the full smoke test plan
- On macOS run `go test ./...` with `TMPDIR=/tmp`: the default temp dir is too long for the unix sockets the `internal/ssh` tests create
- Cobra does not reset `rootCmd` flag state between `Execute` calls, so CLI tests that set flags must reset them afterward (see `resetChangedFlags` in `cmd/amika`)

## Environment Variables

| Variable | Purpose |
|----------|---------|
| `AMIKA_STATE_DIRECTORY` | Override default state directory (`~/.local/state/amika`) |
| `AMIKA_API_URL` | Override remote API base URL (default: `https://app.amika.dev`) |
| `AMIKA_BINARY_PATH` | Absolute path to the `amika` executable recorded in generated config (the SSH `ProxyCommand`). Defaults to the running binary; set it inside a wrapper script so the wrapper names itself and the environment it exports survives |
| `AMIKA_WORKOS_CLIENT_ID` | Override default WorkOS client ID for `amika auth login` |
| `AMIKA_RUN_EXPENSIVE_TESTS` | Gate for expensive Docker integration tests. No test opts into it today; see `docs/development/testing.md` |

## Cursor Cloud specific instructions

See [AGENTS.cursor.md](AGENTS.cursor.md).

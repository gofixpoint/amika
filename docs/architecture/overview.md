# Architecture Overview

Amika is an open-source CLI and HTTP API for running AI coding agents in sandboxes. Each sandbox comes pre-configured with development tools and agent CLIs — Claude Code, Codex, and OpenCode — ready to go out of the box.

For the vision and roadmap, see [roadmap.md](roadmap.md). For user-facing docs, see [README.md](../../README.md).

## Core Concepts

**Docker-backed sandboxes**: Persistent containers with controlled filesystem mounts. Agents get an isolated environment at `/home/amika/workspace` with fine-grained access control per mount.

**Materialization**: Ephemeral Docker containers run scripts or commands, and their output files are copied to a host destination via `rsync`.

**Mount modes**: Host directories can be mounted into sandboxes with three access modes:

- `ro` — read-only bind mount
- `rw` — read-write bind mount (writes sync back to host)
- `rwcopy` — read-write snapshot in a Docker volume (default; host is not modified)

**Credential discovery**: Amika scans for locally stored API credentials from Claude Code, Codex, OpenCode, and Amp, then auto-mounts them into containers so coding agents can authenticate without manual setup.

**Preset images**: Bundled Dockerfiles (`coder`, `claude`) that include common dev tools and coding agent CLIs. Auto-built on first use.

## Commands

| Command                                       | Description                                                                         |
| --------------------------------------------- | ----------------------------------------------------------------------------------- |
| `amika materialize`                           | Run a script/command in an ephemeral container and copy outputs to a host directory |
| `amika sandbox create\|list\|connect\|delete` | Manage persistent Docker sandboxes                                                  |
| `amika volume list\|delete`                   | Manage tracked Docker volumes created by `rwcopy` mounts                            |
| `amika auth extract`                          | Discover local credentials and print shell environment assignments                  |
| `amika-server`                                | HTTP server exposing the same functionality as a REST API                           |

See [cli-reference.md](../cli-reference.md) for full flag documentation.

## Package Layout

```
cmd/amika/
  main.go              CLI entry point, root Cobra command
  sandbox.go           sandbox create/list/connect/delete commands
  materialize.go       Docker-based materialize command
  volume.go            volume list/delete commands
  auth.go              auth extract command
  v0.go                Legacy v0 mount/unmount/materialize (hidden)

cmd/amika-server/
  main.go              HTTP server entry point (REST API)

internal/
  sandbox/             Docker sandbox management
    sandbox.go           Sandbox paths and temp directory creation
    docker.go            Docker container and volume operations
    image_resolution.go  Preset image resolution and auto-build
    names.go             Random sandbox name generation
    store.go             Sandbox state persistence (JSONL)
    volume_store.go      Volume state persistence (JSONL)
    file_mount_store.go  File mount state persistence (JSONL)
    presets.go           Embeds preset Dockerfiles via go:embed
    presets/
      coder/Dockerfile   Coder preset (Claude + Codex + OpenCode)
      claude/Dockerfile  Claude-only preset

  auth/                Credential discovery
    auth.go              CredentialSet type, env var rendering
    discovery.go         Multi-source credential scanning with priority

  agentconfig/         Agent credential auto-mounting
    agentconfig.go       Discovers Claude/Codex/OpenCode config files and
                         produces MountBindings for containers

  config/              XDG path resolution and state file locations
  basedir/             XDG base directory resolution
  httpapi/             HTTP handler for the REST API server
  app/                 Application service layer implementation
  ports/               Port interfaces for Docker and store operations

  mount/               bindfs-based mount/unmount operations (v0)
  materialize/         Local sandbox script execution (v0)
  state/               JSONL mount state persistence (v0)
  deps/                Dependency checking (macFUSE, bindfs) (v0)

pkg/amika/             Public service API (used by both CLI and HTTP server)
  service.go           Service interface and implementation
  requests.go          Request types
  responses.go         Response types
```

## System Dependencies

| Tool   | Required By                        | Purpose                                    |
| ------ | ---------------------------------- | ------------------------------------------ |
| Docker | `materialize`, `sandbox`, `volume` | Container runtime for sandboxes            |
| rsync  | `materialize`                      | Copies output files from container to host |

## State Storage

Amika stores state in XDG-compliant paths (default `~/.local/state/amika/`). See [storage.md](../storage.md) for the full file list.

The `AMIKA_STATE_DIRECTORY` environment variable overrides the default location.

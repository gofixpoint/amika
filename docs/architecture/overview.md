# Architecture Overview

Amika is an open-source CLI for running AI coding agents in remote rigs. Each
rig comes pre-configured with development tools and agent CLIs, including
Claude Code, Codex, and OpenCode, ready to go out of the box.

For user-facing docs, see [README.md](../../README.md).

## Core Concepts

**Rigs**: Persistent remote sandboxes provisioned through the Amika control plane. Agents get an isolated environment at `/home/amika/workspace`.

**Credential discovery**: `amika secret extract` scans for locally stored API credentials from Claude Code, Codex, OpenCode, and Amp and displays them masked, so they can be reviewed and optionally pushed as Amika secrets. Rigs themselves receive credentials from the control plane, not from the host.

**Preset images**: Environments (`coder`, `coder-plus-docker`) that include
common development tools and coding agent CLIs. The control plane provisions
the selected preset for each rig.

## Commands

| Command                                       | Description                                                                          |
| --------------------------------------------- | ------------------------------------------------------------------------------------ |
| `amika sandbox create\|list\|connect\|delete` | Manage persistent remote rigs                                                        |
| `amika secret extract`                        | Discover local credentials, display them masked, and optionally push them as secrets |

See [cli-reference.md](../cli-reference.md) for full flag documentation.

## Package Layout

All Go sources live under `go/` (Go module `github.com/gofixpoint/amika/go`).

```
go/
  cmd/amika/
    main.go              CLI entry point, root Cobra command
    sandbox.go           sandbox create/list/connect/delete commands
    auth.go              auth login/logout/status commands
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

    config/              XDG path resolution and state file locations
    basedir/             XDG base directory resolution
    app/                 Application service layer implementation
    ports/               Port interfaces for Docker and store operations

    materialize/         Local sandbox script execution (v0)

  pkg/amika/             Public Go service API
    service.go           Service interface and implementation
    requests.go          Request types
    responses.go         Response types
```

## State Storage

Amika stores state in XDG-compliant paths (default `~/.local/state/amika/`). See [storage.md](../storage.md) for the full file list.

The `AMIKA_STATE_DIRECTORY` environment variable overrides the default location.

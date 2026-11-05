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
    sandbox/             Client-side rig helpers
      presets.go           Preset validation; embeds the sandbox image bundle
      names.go             Random rig name generation
      github_auth_mode.go  GitHub auth mode validation
      agent_skill.go       amika-cli agent skill from the embedded bundle

    auth/                Credential discovery
      auth.go              CredentialSet type, env var rendering
      discovery.go         Multi-source credential scanning with priority

    config/              XDG path resolution and state file locations
    basedir/             XDG base directory resolution

  pkg/amika/             Rig types the CLI renders
    types.go             Sandbox, PortBinding, SandboxCreator
```

## State Storage

Amika stores state in XDG-compliant paths (default `~/.local/state/amika/`). See [storage.md](../storage.md) for the full file list.

The `AMIKA_STATE_DIRECTORY` environment variable overrides the default location.

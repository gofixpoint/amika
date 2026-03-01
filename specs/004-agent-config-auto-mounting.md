# Agent Config Auto-Mounting

## Overview

This spec defines automatic mounting of coding agent configuration files (e.g., Claude Code settings) into sandboxes and materialized containers. The logic is extracted into a shared `internal/agentconfig` package so both `amika sandbox create` and `amika materialize` use the same discovery and mounting behavior.

## Motivation

Coding agents like Claude Code store configuration on the host that they need at runtime:

| Host path        | Type      | Contents                             |
| ---------------- | --------- | ------------------------------------ |
| `~/.claude/`     | Directory | Settings, credentials, project state |
| `~/.claude.json` | File      | API keys and preferences             |

Currently, only `amika materialize` auto-mounts these files, and it mounts them to the wrong container path (`/root/.claude` instead of `/home/amika/.claude`, which is where `$HOME` points in the preset Dockerfiles). The `sandbox create` command does not mount agent config at all, requiring users to manually pass `--mount` flags.

This spec:

1. Extracts config discovery into a shared package.
2. Fixes the container target path to match `$HOME` in the preset images.
3. Adds auto-mounting to both `sandbox create` and `materialize` using rwcopy for isolation (Docker volumes for directories, file-based rwcopy for files per spec 003).

## Goals

1. Auto-mount agent config for the `claude` and `coder` presets in both `sandbox create` and `materialize`.
2. Use rwcopy isolation for both commands — the container gets its own copy and changes do not propagate back to the host.
3. Fix container target paths to `/home/amika/.claude` and `/home/amika/.claude.json`.
4. Make discovery logic testable and reusable.

## Non-Goals

1. Supporting agent config for non-Claude tools (e.g., Codex, OpenCode config files). This can be added later by extending the discovery functions.
2. Automatically detecting the container `$HOME` — the target path is a constant derived from the preset Dockerfiles.
3. Mounting agent config for custom (non-preset) images.

## Agent Config Discovery

### New Package: `internal/agentconfig`

This package discovers agent configuration files on the host and produces mount specifications. It has no CLI dependencies and is consumed by both command handlers.

### `MountSpec` Type

```go
type MountSpec struct {
    HostPath      string // absolute path on host
    ContainerPath string // absolute path in container
    IsDir         bool   // true = directory, false = file
}
```

### Discovery Function

`ClaudeMounts(homeDir string) []MountSpec`

Takes the user's home directory as a parameter (for testability). Returns mount specs for Claude config files that exist on disk:

1. Checks if `{homeDir}/.claude/` exists and is a directory. If so, adds a spec with `ContainerPath: "/home/amika/.claude"`, `IsDir: true`.
2. Checks if `{homeDir}/.claude.json` exists and is a regular file. If so, adds a spec with `ContainerPath: "/home/amika/.claude.json"`, `IsDir: false`.

Returns nil if neither exists. Does not return errors for missing files — absence is normal.

### Conversion Function

`RWCopyMounts(specs []MountSpec) []sandbox.MountBinding`

- Converts specs to rwcopy mounts (Type="bind", Mode="rwcopy").
- Used by both `sandbox create` and `materialize`. The rwcopy processing loop handles these: directories become Docker volumes, files become file-based rwcopy mounts (spec 003).

### Preset Check

`IsAgentPreset(preset string) bool`

- Returns true for `"claude"` and `"coder"`.
- Callers use this to decide whether to invoke discovery.

## Container Target Paths

The preset Dockerfiles (`internal/sandbox/presets/claude/Dockerfile` and `internal/sandbox/presets/coder/Dockerfile`) both set `ENV HOME=/home/amika`. Agent config is mounted relative to this home directory:

| Host             | Container                  |
| ---------------- | -------------------------- |
| `~/.claude/`     | `/home/amika/.claude`      |
| `~/.claude.json` | `/home/amika/.claude.json` |

This fixes the current `materialize` behavior which incorrectly mounts to `/root/.claude`.

## Integration: `sandbox create`

In the sandbox create handler, after parsing user-specified mounts and before `validateMountTargets`:

```go
if agentconfig.IsAgentPreset(preset) {
    homeDir, err := os.UserHomeDir()
    if err == nil {
        agentMounts := agentconfig.RWCopyMounts(agentconfig.ClaudeMounts(homeDir))
        mounts = append(mounts, agentMounts...)
    }
}
```

The appended mounts have Mode="rwcopy" and flow through the existing processing loop:

- `~/.claude/` (IsDir=true) → Docker volume rwcopy (existing spec 002 flow)
- `~/.claude.json` (IsDir=false) → file-based rwcopy (spec 003 flow)

Agent config mounts are appended before target validation, so user-specified `--mount` flags that conflict with agent config paths will produce a clear duplicate-target error.

## Integration: `materialize`

Replace the inline Claude config block (`cmd/amika/materialize.go` lines 79-100) with:

```go
if agentconfig.IsAgentPreset(preset) {
    homeDir, err := os.UserHomeDir()
    if err == nil {
        agentMounts := agentconfig.RWCopyMounts(agentconfig.ClaudeMounts(homeDir))
        mounts = append(mounts, agentMounts...)
    }
}
```

This uses rwcopy so the container gets its own isolated copy — changes inside the ephemeral container do not propagate back to the host's `~/.claude/` or `~/.claude.json`. The materialize command must process rwcopy mounts the same way `sandbox create` does (creating Docker volumes for directories, file-based copies for files).

### Cleanup

Unlike `sandbox create`, materialize runs ephemeral containers (`docker run --rm`) that are not tracked in `sandboxes.jsonl`. The rwcopy resources created for agent config (Docker volumes and file-based copies) must be cleaned up unconditionally after the container exits, regardless of whether the container succeeded or failed. This means:

- **Docker volumes** created for directory rwcopy: `docker volume rm` after the container exits.
- **File-based copies** created for file rwcopy: `os.RemoveAll` on the copy directory after the container exits.
- **No state tracking**: since these are ephemeral, they should not be saved to `volumes.jsonl` or `rwcopy-mounts.jsonl`. They are created before the container runs and deleted after it exits, using `defer` for reliability.
- **On creation failure** (before the container runs): the same rollback logic applies — clean up any partially created volumes or file copies.

## Test Plan

### `internal/agentconfig` Unit Tests

1. `ClaudeMounts` with both `~/.claude/` and `~/.claude.json` present — returns two specs with correct paths and IsDir values.
2. `ClaudeMounts` with only `~/.claude/` present — returns one directory spec.
3. `ClaudeMounts` with only `~/.claude.json` present — returns one file spec.
4. `ClaudeMounts` with neither present — returns nil.
5. `RWCopyMounts` conversion — produces MountBindings with Type="bind", Mode="rwcopy".
6. `IsAgentPreset` — true for "claude" and "coder", false for "", "custom", etc.
7. Container paths use `/home/amika/`, not `/root/`.

### Integration (in `cmd/amika/` tests)

1. Agent config mounts are included for "claude" and "coder" presets.
2. Agent config mounts are not included for non-preset or custom-image sandboxes.
3. User-specified mount to `/home/amika/.claude` conflicts with agent config and produces a duplicate-target error.

## Acceptance Criteria

1. `amika sandbox create --preset coder` with `~/.claude/` and `~/.claude.json` present auto-mounts both as rwcopy.
2. `amika sandbox create --preset coder` without Claude config on host creates the sandbox normally (no error).
3. `amika materialize --preset claude --cmd "ls /home/amika/.claude"` succeeds (config is at correct path, not `/root/.claude`).
4. `amika materialize` uses rwcopy — changes inside the container do not modify the host's `~/.claude/` or `~/.claude.json`.
5. rwcopy volumes and file mounts created by `materialize` are cleaned up after the ephemeral container exits.
6. Both mounts appear in `amika volume list` after sandbox creation (one directory, one file).

## Dependencies

1. File-based rwcopy mounts (spec 003) for handling `~/.claude.json` in `sandbox create`.
2. Existing Docker volume rwcopy (spec 002) for handling `~/.claude/` in `sandbox create`.
3. Preset Dockerfiles with `ENV HOME=/home/amika`.

## Future Considerations

1. Additional agent configs (Codex, OpenCode) can be added by writing new discovery functions in `internal/agentconfig` and calling them alongside `ClaudeMounts`.
2. Per-project agent config (e.g., `.claude/` inside a git repo) could be handled separately from home-directory config.
3. The container home path could be made configurable per-preset rather than a constant, if future presets use different home directories.

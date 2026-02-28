# Sandbox `rwcopy` and Volume Management Spec

## Overview

This spec defines a new `rwcopy` mode for `amika sandbox create` and introduces first-class volume lifecycle management in Amika state and CLI.

`rwcopy` provides a read-write filesystem view in the sandbox by snapshot-copying a host directory into a Docker volume at sandbox creation time. Changes inside the sandbox do not sync back to host files.

This spec also adds tracked volume operations (`list`, `delete`) and updates sandbox deletion behavior to preserve or delete associated volumes based on an explicit flag.

## Goals

1. Add `rwcopy` as a supported sandbox mount mode.
2. Make `rwcopy` the default mode when `--mount` mode is omitted.
3. Store and manage volume metadata separately from sandbox metadata.
4. Support re-attaching existing tracked volumes to new sandboxes.
5. Add safe volume lifecycle commands with in-use protection.
6. Keep behavior backward-compatible for existing sandbox state entries.

## Non-Goals

1. Exposing a public `amika volume create` command.
2. Continuous sync between host and sandbox for `rwcopy`.
3. Remote/container-provider support beyond Docker in this iteration.

## CLI Changes

### `amika sandbox create`

#### Existing Flag

- `--mount source:target[:mode]`
- Supported modes become: `ro`, `rw`, `rwcopy`
- **Default mode changes from `rw` to `rwcopy`** when `:mode` is omitted

#### New Flag

- `--volume name:target[:mode]`
- Attaches an existing tracked Docker volume by name
- Supported modes: `rw` (default), `ro`

#### Validation Rules

1. `target` must be absolute.
2. Mount targets must be unique across both `--mount` and `--volume`.
3. `rwcopy` source must exist and be a directory.
4. Volume name for `--volume` must exist in tracked volume state (and preferably in Docker).

### `amika sandbox delete <name>`

#### New Flag

- `--delete-volumes` (default: `false`)

#### Behavior

1. Remove container as today.
2. Resolve associated volumes via volume state references.
3. If `--delete-volumes=false`: preserve volumes, remove sandbox references.
4. If `--delete-volumes=true`: attempt to delete associated volumes, remove references.
5. Always print associated volumes and status (`deleted`, `preserved`, `delete-failed`).

### New Top-Level Command: `amika volume`

#### `amika volume list`

Print tracked volumes with:

- name
- created timestamp
- source/provenance (if available)
- in-use status
- associated sandbox names

#### `amika volume delete <name>`

- Default: fail if volume is referenced by one or more sandboxes.
- `--force`: allow deletion even if in use.
- On success: remove Docker volume and remove state entry.

## Data Model and State

### New State File

- `volumes.jsonl` in same state dir as `sandboxes.jsonl`
- Path:
  - `${XDG_STATE_HOME:-~/.local/state}/amika/volumes.jsonl`
  - or `${AMIKA_STATE_DIRECTORY}/volumes.jsonl`

### Volume State Entry

Each line stores one volume record, including:

- `name`
- `createdAt`
- `createdBy` (e.g., `rwcopy`, `manual-attach`)
- `sourcePath` (optional, for rwcopy provenance)
- `sandboxRefs` (`[]string`)
- optional attach/update timestamps

### Sandbox State (`sandboxes.jsonl`)

Extend mount representation to support both:

- bind mounts (host path source)
- volume mounts (volume name source)

Use explicit mount type to avoid ambiguity in mixed configurations.

Backward compatibility:

- Existing entries without new fields must continue to parse.

## Runtime Semantics

### `rwcopy` Creation Flow

For each `--mount <source>:<target>:rwcopy` (or omitted mode):

1. Create auto-generated Docker volume name.
2. Snapshot-copy host directory content into volume using transient container.
3. Mount volume into sandbox at target as read-write.
4. Record volume in `volumes.jsonl`.
5. Add sandbox reference to that volume.

### Reattach Existing Volume Flow (`--volume`)

1. Validate tracked volume exists.
2. Mount volume at target with selected mode.
3. Add sandbox reference.

### Failure and Rollback

If sandbox creation fails after creating resources:

1. Best-effort remove newly created rwcopy volumes.
2. Revert volume state entries/refs created for this operation.
3. Return actionable error.

## Internal Architecture Changes

### `cmd/amika/sandbox.go`

1. Extend mount parsing to allow `rwcopy`.
2. Change default `--mount` mode to `rwcopy`.
3. Add parsing for `--volume`.
4. Enforce target uniqueness across all mounts.
5. Integrate volume lifecycle handling into create and delete flows.

### `cmd/amika/volume.go` (new)

Add `volume list` and `volume delete` command handlers and wiring to root command.

### `internal/sandbox/docker.go` and new volume helpers

Add Docker helpers for:

- create volume
- remove volume
- copy host dir into volume
- mixed bind + volume mount support during container creation

### `internal/sandbox/volume_store.go` (new)

Add persistent store for volume records and reference management.

### `internal/basedir/basedir.go`

Add:

- `volumes.jsonl` constant
- `VolumesStateFile()` path method
- `VolumesStateFileIn(stateDir)` helper

### `internal/config/config.go`

Add:

- `VolumesStateFile()` resolution with `AMIKA_STATE_DIRECTORY` override support

## Output and UX Behavior

### `sandbox create` Confirmation Prompt

When mounts are present, prompt should display resolved mount type clearly:

- bind host mount (`ro`/`rw`)
- rwcopy snapshot mount (`rwcopy`)
- existing volume mount (`--volume`)

### `sandbox delete` Output

Always include associated volume outcome lines, for example:

- `volume <name>: preserved`
- `volume <name>: deleted`
- `volume <name>: delete failed: <reason>`

## Test Plan

### Command Parsing and Validation

1. `--mount /src:/dst` defaults to `rwcopy`.
2. `rwcopy` accepted; unknown modes rejected.
3. `--volume` parse supports optional mode default `rw`.
4. Duplicate target across `--mount` and `--volume` is rejected.

### Store and State

1. Volume store save/get/list/remove.
2. Reference add/remove behavior.
3. In-use detection based on refs.
4. Path resolution tests for `volumes.jsonl` default and env override.
5. Sandbox store round-trip for mixed mount types.

### Delete Semantics

1. `sandbox delete` default preserves volumes and clears refs.
2. `sandbox delete --delete-volumes` deletes volumes and clears refs.
3. Partial volume deletion failures are surfaced in output without state corruption.

### Volume Command

1. `volume list` shows usage and associations.
2. `volume delete` fails when in use.
3. `volume delete --force` succeeds.

## Acceptance Criteria

1. `--mount` without explicit mode behaves as `rwcopy`.
2. Files changed in rwcopy mount inside sandbox do not modify host source files.
3. Created rwcopy volumes are tracked in `volumes.jsonl`.
4. `amika volume list` reflects tracked volume usage accurately.
5. `amika volume delete` enforces in-use protection unless `--force`.
6. `sandbox delete` preserves volumes by default and reports outcomes.
7. `sandbox delete --delete-volumes` attempts cleanup and reports outcomes.
8. Existing sandboxes state remains readable after upgrade.

## Dependencies

1. Docker volume support (`docker volume create/rm`).
2. Transient copy container image availability (e.g., `alpine`) for snapshot copy.
3. Existing Amika state directory and JSONL persistence patterns.

## Future Considerations

1. Optional `volume prune` command for unreferenced volumes.
2. Optional checksum/metadata for rwcopy snapshot provenance.
3. Optional reuse strategy for repeated rwcopy from same source.
4. Support for non-Docker providers with equivalent volume abstractions.

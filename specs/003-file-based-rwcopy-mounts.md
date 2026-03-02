# File-Based rwcopy Mounts

## Overview

This spec extends the rwcopy mount system (spec 002) to support **single-file mounts** alongside the existing directory-based Docker volume mounts.

Docker named volumes are directory-level constructs — they cannot represent a single file. When a source path for an rwcopy mount is a file (e.g., `~/.claude.json`), Amika must use a different backing mechanism: a host-side copy stored in the Amika state directory, bind-mounted into the container.

File-based rwcopy mounts provide the same isolation guarantee as Docker volume rwcopy: the sandbox gets its own editable copy and changes do not propagate back to the host original.

## Motivation

The immediate use case is agent config auto-mounting for sandboxes. Claude Code stores configuration in two locations:

| Host path        | Type      | Purpose                              |
| ---------------- | --------- | ------------------------------------ |
| `~/.claude/`     | Directory | Settings, credentials, project state |
| `~/.claude.json` | File      | API keys and preferences             |

The directory (`~/.claude/`) can use the existing Docker volume rwcopy flow. The file (`~/.claude.json`) cannot, because:

1. **Docker named volumes always mount as directories.** Mounting a volume at `/home/amika/.claude.json` creates a _directory_ called `.claude.json`, not a file.
2. **A plain bind mount of the file** (rw or ro) either exposes the host file to mutation or prevents the sandbox from modifying its own copy.
3. **Wrapping the file in a Docker volume** (by copying it into a volume and mounting the volume at the parent directory) would shadow other mounts and content at that parent path.

File-based rwcopy mounts solve this by copying the file into Amika's state directory and bind-mounting the copy.

## Goals

1. Extend `rwcopy` mode to accept single files, not only directories.
2. Store file copies in a structured, cleanable location under the Amika state directory.
3. Track file-based mounts with the same lifecycle semantics as Docker volumes (sandbox refs, in-use protection, cleanup on sandbox delete).
4. Surface file-based mounts in `amika volume list` and `amika volume delete` alongside Docker volumes, with a type indicator to distinguish them.

## Non-Goals

1. Syncing file changes back to the host (this is explicitly not rwcopy behavior).
2. Supporting file-based rwcopy for _directories_ (Docker volumes remain the mechanism for directories).
3. Deduplication across sandboxes — each sandbox gets its own copy.

## Relationship to Docker Volumes

Docker volume rwcopy (spec 002) and file-based rwcopy (this spec) use different backing stores but share identical lifecycle semantics.

**Backing store differences:**

|                                  | Docker volume rwcopy (spec 002)        | File-based rwcopy (this spec)                               |
| -------------------------------- | -------------------------------------- | ----------------------------------------------------------- |
| **Source type**                  | Directory                              | Single file                                                 |
| **Backing store**                | Docker named volume                    | File in Amika state directory                               |
| **How data is copied**           | Transient Alpine container (see below) | Go `os.ReadFile`/`os.WriteFile` copies the file on the host |
| **Container mount type**         | Volume mount (`-v volumeName:/target`) | Bind mount (`-v /state/copy:/target`)                       |
| **Tracked in**                   | `volumes.jsonl`                        | `rwcopy-mounts.jsonl` (separate file)                       |
| **How backing store is deleted** | `docker volume rm`                     | `os.RemoveAll` on copy directory                            |

**Shared lifecycle semantics (identical for both):**

- Sandbox references track which sandboxes use each mount
- In-use protection prevents deletion of mounts referenced by sandboxes
- `amika volume list` shows both (Docker volumes as `directory`, file mounts as `file`)
- `amika volume delete` works for both, with `--force` to override in-use protection
- `sandbox delete` follows `--keep-volumes` / `--delete-volumes` flags for both, with an interactive prompt when neither flag is set and exclusive mounts exist

### The Alpine copy trick (Docker volume rwcopy)

Docker named volumes live in Docker-managed storage and are not directly accessible from the host filesystem. To copy host files into a volume, the existing rwcopy implementation (`CopyHostDirToVolume` in `internal/sandbox/docker.go`) uses a transient Alpine container as an intermediary:

```
docker run --rm \
  -v /host/source/dir:/src:ro \
  -v myVolumeName:/dst \
  alpine:3.20 \
  sh -c "cp -a /src/. /dst/"
```

This spins up a throwaway container with two mounts: the host directory (read-only) and the Docker volume (read-write). The `cp -a` inside the container copies everything from one to the other, then the container is removed. It's the only way to populate a Docker named volume from host data without a running container.

File-based rwcopy mounts avoid this indirection entirely — since the backing store is just a file on the host filesystem, a simple Go file copy suffices.

## Data Model and State

### New State File

Path (same resolution as `volumes.jsonl`):

- `${AMIKA_STATE_DIRECTORY}/rwcopy-mounts.jsonl`
- or `${XDG_STATE_HOME:-~/.local/state}/amika/rwcopy-mounts.jsonl`

### New Data Directory

File copies are stored under:

- `${AMIKA_STATE_DIRECTORY}/rwcopy-mounts.d/{mount-name}/{filename}`
- or `${XDG_STATE_HOME:-~/.local/state}/amika/rwcopy-mounts.d/{mount-name}/{filename}`

Each mount gets its own subdirectory to avoid filename collisions and simplify cleanup (`os.RemoveAll` on the mount directory).

### File Mount State Entry

Each line in `rwcopy-mounts.jsonl` stores one record:

| Field         | Type     | Description                          |
| ------------- | -------- | ------------------------------------ |
| `name`        | string   | Unique mount name (generated)        |
| `type`        | string   | `"file"`                             |
| `createdAt`   | string   | RFC 3339 timestamp                   |
| `createdBy`   | string   | `"rwcopy"`                           |
| `sourcePath`  | string   | Original host file path              |
| `copyPath`    | string   | Absolute path to the local copy      |
| `sandboxRefs` | []string | Sandbox names referencing this mount |

### Mount Naming Convention

Format: `amika-rwcopy-file-{sandboxName}-{sanitizedTarget}-{nanoTimestamp}`

This parallels the Docker volume naming (`amika-rwcopy-{sandboxName}-{sanitizedTarget}-{nanoTimestamp}`) with a `-file-` infix to distinguish the two types.

### Filesystem Layout Example

```
$XDG_STATE_HOME/amika/
├── volumes.jsonl                          # Docker volume state (existing)
├── rwcopy-mounts.jsonl                    # File mount state (new)
└── rwcopy-mounts.d/                       # File copy storage (new)
    └── amika-rwcopy-file-coral-tokyo-home-amika--claude-json-1709312400000000000/
        └── .claude.json                   # Copied file
```

## Runtime Semantics

### Creation Flow

During `sandbox create`, when processing an rwcopy mount whose source is a regular file (not a directory):

1. Generate a unique mount name.
2. Create the mount directory under `rwcopy-mounts.d/`.
3. Copy the source file into the mount directory, preserving permissions.
4. Save the `FileMountInfo` record to `rwcopy-mounts.jsonl`.
5. Add a runtime bind mount: the copied file maps to the container target path, read-write.

### Failure and Rollback

If sandbox creation fails after creating file mount resources:

1. Remove all newly created mount directories (`os.RemoveAll`).
2. Remove corresponding state entries from `rwcopy-mounts.jsonl`.
3. This runs alongside the existing Docker volume rollback — both rollbacks execute.

### Sandbox Deletion

File-based rwcopy mounts follow the same deletion behavior as Docker volumes:

1. If `--keep-volumes` is set: preserve all mounts, remove sandbox references only.
2. If `--delete-volumes` is set: delete unreferenced mounts, remove sandbox references.
3. If neither flag is set: check for mounts exclusively referenced by this sandbox (across both Docker volumes and file mounts). If any exist, prompt the user interactively. If none are exclusive, silently preserve.
4. Report outcomes for each mount (`preserved`, `deleted`, `delete-failed`) in the same output block as Docker volume outcomes.

Deleting a file-based mount means:

- `os.RemoveAll` on the mount's copy directory (the directory under `rwcopy-mounts.d/`)
- Remove the state entry from `rwcopy-mounts.jsonl`

### Atomicity

File copy operations use a create-directory-then-copy-file sequence. On failure at any step, the rollback function removes the partially created directory. The JSONL store's read-all/write-all pattern ensures state file consistency.

## CLI Changes

### `amika volume list`

Add a `TYPE` column:

```
NAME                                        TYPE       CREATED               IN_USE  SANDBOXES    SOURCE
amika-rwcopy-coral-tokyo-home-amika-...     directory  2026-01-02T00:00:00Z  yes     coral-tokyo  /Users/me/.claude
amika-rwcopy-file-coral-tokyo-home-...      file       2026-01-02T00:00:00Z  yes     coral-tokyo  /Users/me/.claude.json
```

- Docker volumes display as `directory`.
- File-based mounts display as `file`.
- "No volumes found." only appears when both stores are empty.

### `amika volume delete <name>`

Lookup order:

1. Check `volumes.jsonl` (Docker volume). If found, use existing delete flow.
2. Check `rwcopy-mounts.jsonl` (file mount). If found, delete the copy directory and state entry.
3. If neither, return "not found" error.

In-use protection and `--force` semantics apply identically to both types.

## Internal Architecture Changes

### `internal/sandbox/file_mount_store.go` (new)

JSONL-backed store following the `volume_store.go` pattern:

```go
type FileMountStore interface {
    Save(info FileMountInfo) error
    Get(name string) (FileMountInfo, error)
    Remove(name string) error
    List() ([]FileMountInfo, error)
    AddSandboxRef(name, sandbox string) error
    RemoveSandboxRef(name, sandbox string) error
    FileMountsForSandbox(sandbox string) ([]FileMountInfo, error)
    IsInUse(name string) (bool, error)
}
```

### `internal/basedir/basedir.go`

Add to `Paths` interface and `xdgPaths`:

- `FileMountsStateFile()` — returns `$stateDir/rwcopy-mounts.jsonl`
- `FileMountsDir()` — returns `$stateDir/rwcopy-mounts.d`

Add public helpers:

- `FileMountsStateFileIn(stateDir string) string`
- `FileMountsDirIn(stateDir string) string`

### `internal/config/config.go`

Add `FileMountsStateFile()` and `FileMountsDir()` with `AMIKA_STATE_DIRECTORY` override support.

### `cmd/amika/sandbox.go`

- Extend the rwcopy processing loop to branch on `stat.IsDir()` vs regular file.
- Directory sources: existing Docker volume flow (unchanged).
- File sources: new file-based rwcopy flow (this spec).
- Expand rollback function to clean up file mounts alongside Docker volumes.
- Extend `resolveDeleteVolumes` to consider exclusive file mounts alongside exclusive Docker volumes when prompting.
- Add `cleanupSandboxFileMounts` paralleling `cleanupSandboxVolumes`, called from the delete handler.

### `cmd/amika/volume.go`

- `volume list`: read from both stores, merge, display with TYPE column.
- `volume delete`: try both stores in sequence.

## Test Plan

### Store and State

1. `FileMountStore` save/get/list/remove round-trip.
2. Sandbox ref add/remove behavior.
3. `FileMountsForSandbox` returns correct subset.
4. `IsInUse` returns true when refs exist, false otherwise.
5. Path resolution for `rwcopy-mounts.jsonl` and `rwcopy-mounts.d` with default and env override.

### Creation and Rollback

1. File-based rwcopy creates the correct directory structure and file copy.
2. Copied file preserves source permissions.
3. On creation failure, rollback removes the mount directory and state entry.
4. Mixed creation (one Docker volume rwcopy + one file rwcopy) rolls back both on failure.

### CLI Commands

1. `volume list` shows both Docker volumes and file mounts with correct TYPE values.
2. `volume list` with no entries prints "No volumes found."
3. `volume delete` on a file mount removes the copy directory and state entry.
4. `volume delete` on an in-use file mount fails without `--force`.
5. `volume delete --force` on an in-use file mount succeeds.

### Sandbox Delete

1. `sandbox delete` with neither flag removes file mount sandbox refs and preserves mounts.
2. `sandbox delete` with exclusive file mounts and no flags prompts the user.
3. `sandbox delete --delete-volumes` deletes unreferenced file mounts from disk.
4. `sandbox delete --keep-volumes` preserves file mounts and removes refs only.
5. `sandbox delete --delete-volumes` preserves file mounts still referenced by other sandboxes.

## Acceptance Criteria

1. `--mount /path/to/file:/target:rwcopy` creates a file-based rwcopy mount (not a Docker volume).
2. The sandbox can read and write the mounted file; changes do not affect the host original.
3. File mounts appear in `amika volume list` with type `file`.
4. `amika volume delete` works for both Docker volumes and file mounts.
5. Sandbox deletion handles file mount cleanup with the same `--keep-volumes` / `--delete-volumes` / interactive prompt semantics as Docker volumes.
6. All file operations are cleaned up on creation failure.

## Dependencies

1. Existing Amika state directory and JSONL persistence patterns (spec 002).
2. `os.ReadFile`/`os.WriteFile` for file copying (no Docker dependency for file mounts).

## Future Considerations

1. Directory-based file mounts — if a future use case requires rwcopy of a directory without Docker, the `rwcopy-mounts.d` structure already supports filesystem trees.
2. Deduplication — multiple sandboxes from the same source could share a single copy with copy-on-write semantics, but this adds complexity for limited benefit.
3. Checksums — storing a hash of the source file at copy time would allow detecting whether the host original has changed since the snapshot.

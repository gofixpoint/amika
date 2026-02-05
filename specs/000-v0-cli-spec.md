# Wisp v0 CLI Specification

## Overview

Wisp v0 provides filesystem mounting and script execution with output materialization. The v0 implementation targets macOS using bindfs and macFUSE.

## Commands

### `wisp v0 materialize`

Runs a script and copies output files to a destination directory. This simulates a sandboxed execution model where the script runs in isolation and its outputs are "materialized" to the host.

```
wisp v0 materialize \
    --script <path> \
    --workdir <path> \
    --outdir <path> \
    --destdir <path>
```

**Arguments:**

| Flag | Required | Description |
|------|----------|-------------|
| `--script` | Yes | Path to the script to execute |
| `--workdir` | Yes | Working directory for script execution |
| `--outdir` | Yes | Directory where the script writes output files |
| `--destdir` | Yes | Host directory where output files are copied after script completes |

**Behavior:**

1. Execute `script` with `workdir` as the current working directory
2. Wait for script to complete
3. Copy all files from `outdir` to `destdir`

**Note:** In v0, there is no actual sandbox. The script runs directly on the host. Future versions may introduce real sandboxing.

---

### `wisp v0 mount`

Mounts a source directory to a target path with specified access mode.

```
wisp v0 mount <src> <target> --mode <mode>
```

**Arguments:**

| Argument | Required | Description |
|----------|----------|-------------|
| `src` | Yes | Source directory to mount |
| `target` | Yes | Target path where source will be mounted |
| `--mode` | Yes | Access mode: `ro`, `rw`, or `overlay` |

**Modes:**

| Mode | Description |
|------|-------------|
| `ro` | Read-only access to source files |
| `rw` | Read-write access; writes go directly to source |
| `overlay` | Read-write access; writes do not affect source |

**Implementation Details:**

- `ro` and `rw` modes use bindfs directly
- `overlay` mode:
  1. Copies `src` to a temporary directory via rsync
  2. Mounts the temporary directory to `target` via bindfs
  3. Temporary directory is cleaned up on unmount

---

### `wisp v0 unmount`

Unmounts a previously mounted target.

```
wisp v0 unmount <target>
```

**Arguments:**

| Argument | Required | Description |
|----------|----------|-------------|
| `target` | Yes | Target path to unmount |

**Behavior:**

1. Unmount the bindfs mount at `target`
2. If the mount was in `overlay` mode, clean up the associated temporary directory
3. Remove the mount from state tracking

---

## Dependencies

Wisp v0 requires the following dependencies on macOS:

- **macFUSE**: Provides FUSE support on macOS
- **bindfs**: FUSE filesystem for mounting directories

The CLI must check for these dependencies at startup and display helpful error messages if they are missing, including installation instructions.

---

## State Management

Active mounts are tracked in `~/.wispbase/` directory. This enables:

- Listing active mounts
- Proper cleanup on unmount (especially for overlay mode temp directories)
- Recovery/cleanup after unexpected termination

---

## Platform Support

v0 targets **macOS only**. Linux and other platforms may be supported in future versions.

---

## Future Considerations

- Actual sandboxing for `materialize` command
- True overlayfs support for `overlay` mode (instead of rsync + bindfs)
- Linux support
- Mount persistence across reboots (optional)

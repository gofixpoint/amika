# Sandbox File Copy

## Overview

Add an `amika sandbox file-copy` command (alias `fcp`) that copies files between the local filesystem and a sandbox. Supports both local (Docker) and remote (SSH) sandboxes, choosing the appropriate transport automatically.

## Motivation

Users need to move files in and out of sandboxes — uploading source code, downloading build artifacts, extracting logs, etc. Today the only option is to shell into a sandbox and use ad-hoc tools. A first-class copy command provides a consistent interface that works across local and remote sandboxes.

## Command Shape

```
amika sandbox file-copy [flags] <from> <to>
amika sandbox fcp [flags] <from> <to>
```

### Arguments

Exactly two positional arguments: `<from>` and `<to>`. Exactly one of them must reference a sandbox using the format `<sandbox-name>:<path>`. The other is a local filesystem path.

| Argument     | Format              | Example                           |
| ------------ | ------------------- | --------------------------------- |
| Local path   | Any filesystem path | `./file.txt`, `/tmp/output/`      |
| Sandbox path | `<name>:<path>`     | `my-sandbox:/home/amika/file.txt` |

**Parsing heuristic:** A colon-separated argument is treated as a sandbox reference only if the portion before the first `:` contains no `/` character. This correctly distinguishes sandbox references from absolute or relative local paths (e.g. `/foo/bar`, `./foo`).

### Flags

| Flag          | Short | Default | Description                  |
| ------------- | ----- | ------- | ---------------------------- |
| `--recursive` | `-r`  | `false` | Recursively copy directories |

The command also inherits the persistent `--local`, `--remote`, and `--remote-target` flags from the `sandbox` parent command.

### Examples

```bash
# Copy a local file into a sandbox
amika sandbox file-copy ./config.yaml my-sandbox:/home/amika/config.yaml

# Copy a file from a sandbox to local filesystem
amika sandbox fcp my-sandbox:/home/amika/output.log ./output.log

# Recursively copy a directory
amika sandbox file-copy -r ./src my-sandbox:/home/amika/src

# Copy a directory out of a sandbox
amika sandbox fcp -r my-sandbox:/home/amika/project ./project
```

## Behavior

### Sandbox Resolution

The command follows the same local-first-then-remote pattern used by `sandbox connect`:

1. Look up the sandbox name in the local state store.
2. If found locally and the provider is `docker`, use Docker copy.
3. If not found locally, fall back to the remote API to get SSH connection info, then use SCP.

### Local Sandbox (Docker)

Uses `docker cp` under the hood. `docker cp` always copies directories recursively, so the `-r` flag is accepted but not passed through to Docker.

### Remote Sandbox (SSH)

Retrieves SSH connection info via the API (`GetSSH`), then invokes `scp` with the SSH options from the returned destination string.

The `-r` flag is passed through to `scp` when set.

### Validation

- Exactly one of `<from>` or `<to>` must reference a sandbox. If both or neither do, the command returns an error.
- The sandbox-side path must be non-empty (e.g. `my-sandbox:` alone is an error).

### Process Replacement

Like `sandbox ssh` and `sandbox connect`, the command uses `syscall.Exec` to replace the amika process with the underlying tool (`docker` or `scp`), so stdin/stdout/stderr and signals pass through directly.

## Dependencies

- **Docker** — required for local sandbox file copy (`docker cp`)
- **scp** / **ssh** — required for remote sandbox file copy

## Future Considerations

- **Local sandbox support via SSH**: If local sandboxes gain SSH access, the transport could unify around SCP for both local and remote.
- **Progress reporting**: Neither `docker cp` nor `scp` provides structured progress output. A future version could add progress bars for large transfers.
- **Glob / wildcard patterns**: The initial version copies a single source path. Wildcard expansion could be added later.

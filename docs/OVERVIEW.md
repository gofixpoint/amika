# Amika Overview

Amika is a Go CLI tool for executing scripts in sandboxed environments with controlled filesystem access and output materialization. It targets macOS and uses bindfs/macFUSE for filesystem mounting.

## Core Concepts

**Sandboxed execution**: Scripts run inside a temporary, isolated directory structure. The sandbox has a root, a working directory (default `/home/amika/workspace`), and an output directory. All paths are forced under the sandbox root for security.

**Materialization**: After a script finishes, amika copies its output files from the sandbox to a host destination directory using rsync, then cleans up the sandbox.

**Filesystem mounts**: Source directories can be mounted to target paths with three access modes: read-only (`ro`), read-write (`rw`), and overlay (copy-on-write isolation).

## Commands

### `amika materialize`

The primary command. Creates a temporary sandbox, runs a script or bash command inside it, and copies the output to a destination.

```bash
# Run a command, copy output to /tmp/dest
amika materialize --cmd "echo hi > result.txt" --destdir /tmp/dest

# Run a script with arguments
amika materialize --script ./gen.sh --destdir /tmp/dest -- arg1 arg2

# Specify a custom output directory within the sandbox
amika materialize --cmd "echo data > /output/file.txt" --outdir /output --destdir /tmp/dest
```

Key flags:
- `--script <path>` or `--cmd <string>` (mutually exclusive) - what to execute
- `--outdir <path>` - sandbox directory to copy from (default: working directory)
- `--destdir <path>` - host directory to copy output to (required)

The child process receives a `AMIKA_SANDBOX_ROOT` environment variable pointing to the sandbox root.

### `amika v0 mount <src> <target> --mode <mode>`

Mount a source directory to a target path with a specified access mode:
- **`ro`**: Read-only via bindfs
- **`rw`**: Read-write via bindfs (writes go to source)
- **`overlay`**: Copies source to a temp directory and mounts that; writes are isolated from the original

Mount state is tracked in `~/.amikabase/mounts.jsonl`.

### `amika v0 unmount <target>`

Unmount a previously mounted target and clean up resources (including overlay temp directories).

## Architecture

```
cmd/amika/           CLI entry point and Cobra command definitions
internal/
  materialize/      Script execution and rsync-based output copying
  sandbox/          Temporary sandbox creation and path resolution
  mount/            Filesystem mount/unmount operations (bindfs)
  state/            JSONL-based mount state persistence
  deps/             Dependency checking (macFUSE, bindfs)
```

## System Dependencies

| Tool | Purpose |
|------|---------|
| bindfs | Virtual filesystem mounting (`brew install bindfs`) |
| macFUSE | FUSE support on macOS (`brew install --cask macfuse`) |
| rsync | File copying (usually pre-installed) |

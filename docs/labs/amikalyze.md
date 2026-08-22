# amikalyze

`amikalyze` is an experimental guardrail that prevents Claude Code and Codex
from using their native edit tools on frozen repository paths. Freeze rules
live with the code in `.amikalyze.toml` files, and temporary exceptions last
only for the agent process launched by `amikalyze run`.

This is a Labs interface with no compatibility guarantees.

## Build

From the repository root:

```bash
make build-amikalyze
./dist/amikalyze --help

# Or use the contributor wrapper:
./bin/amikalyze --help
```

The wrapper is for source checkouts. Labs binaries are not currently published
as release artifacts.

## Configure frozen paths

Place `.amikalyze.toml` at the repository root or in any subdirectory:

```toml
[[freezes]]
label = "schema"
paths = [
  "schema/**/*.sql",
]

[[freezes]]
label = "protocol"
paths = [
  "proto/**/*.proto",
]

[[freezes]]
label = "vendor"
paths = [
  "vendor/**",
  "some/full/filepath.txt",
]
```

Each `[[freezes]]` entry requires a label and at least one path. Labels may use
letters, digits, `.`, `_`, and `-`.

Patterns use `/` separators. `*`, `?`, and character classes match within one
path segment; a segment equal to `**` matches zero or more complete segments.
Absolute paths, `..`, backslashes, and embedded forms such as `foo**bar` are
rejected.

## Config discovery

For each attempted edit, amikalyze:

1. Resolves the agent session's Git worktree root.
2. Walks from that root down the target file's ancestor directories.
3. Loads every `.amikalyze.toml` on that path.
4. Matches each config's patterns relative to the directory containing it.

Rules accumulate. A config in `database/` applies below `database/`, not to a
sibling such as `web/`. A label may appear only once across the configs that
apply to one target. Amikalyze never scans the whole repository or walks above
the Git worktree root.

An existing `.amikalyze.toml` is implicitly frozen. Use `--unfreeze-path` when
you intentionally want an agent to edit it.

## Install agent hooks

Select each agent explicitly:

```bash
amikalyze hooks install --agent claude
amikalyze hooks install --agent codex
amikalyze hooks install --agent claude --agent codex
```

The installer writes a global synchronous `PreToolUse` hook while preserving
unrelated settings:

- Claude Code: `~/.claude/settings.json`, matching `Edit|Write`.
- Codex: `$CODEX_HOME/hooks.json` or `~/.codex/hooks.json`, matching
  `apply_patch`.

Codex requires newly installed hooks to be reviewed and trusted. Open `/hooks`
in Codex after installation.

Remove selected hooks with:

```bash
amikalyze hooks uninstall --agent claude --agent codex
```

Reinstall after moving or replacing the `amikalyze` executable so stored hook
commands point at the new absolute path.

## Temporarily unfreeze paths

Run an agent as an amikalyze child process:

```bash
amikalyze run --unfreeze schema -- codex
amikalyze run --unfreeze schema --unfreeze protocol -- claude
amikalyze run --unfreeze-path schema/users.sql -- codex
```

Both flags are repeatable. `--unfreeze` disables every applicable rule with
that label. `--unfreeze-path` accepts one exact, repository-relative file path
and disables every matching rule for that file. It does not accept globs or
directories.

Overrides apply only to the selected Git worktree and are inherited by the
child agent and its subagents. They disappear when that process exits. In a
multi-file edit, every frozen target must be covered or the entire edit is
blocked.

## What a blocked agent sees

Amikalyze denies the tool call before it runs and returns the path, label,
pattern, and config file to the agent. The feedback also tells the model not to
retry through another tool or shell command.

## Enforcement boundary

Amikalyze v1 gates Claude Code's native `Edit` and `Write` tools and Codex's
native `apply_patch` tool. It does not determine the filesystem effects of
arbitrary shell commands, generators, or third-party MCP tools. Treat it as a
guardrail for structured agent edits, not an operating-system security
boundary.

# Freeze agent edits by path

`amikalyze` is an experimental Labs tool for protecting repository files from
native coding-agent edit tools. Define labeled path globs in hierarchical
`.amikalyze.toml` files, install a hook for Claude Code or Codex, and use
`amikalyze run` when a particular agent session needs an explicit exception.

The current implementation freezes complete files. Symbol annotations and
post-edit Git or PR checks are not implemented.

See the [amikalyze Labs reference](labs/amikalyze.md) for configuration,
installation, override semantics, and the enforcement boundary.

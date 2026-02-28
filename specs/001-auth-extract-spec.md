# Auth Extract CLI Specification

## Overview

Add an `auth extract` command that discovers locally stored API credentials and prints shell environment assignments. This is intended for piping into `eval` for sandboxed agent workflows.

## CLI Interface

Command:

```bash
amika auth extract [--export] [--homedir <DIR>] [--no-oauth]
```

Flags:

- `--export` (bool): prefix each output line with `export `
- `--homedir <DIR>` (string, optional): override home directory used for credential discovery
- `--no-oauth` (bool): skip OAuth token sources

CLI semantics alignment decisions:

- Keep `auth extract` (matches existing `sandbox create|delete|list` subcommand structure).
- Use `--homedir` to match existing compact path-flag naming style (`--workdir|--outdir|--destdir`).
- Ensure machine-readable stdout: no banners, no status text, only assignments.

## Behavior

1. Build discovery options from flags:
   - `home_dir = <DIR>` when provided
   - `include_oauth = !no_oauth`
2. Run credential discovery engine.
3. Aggregate credentials into:
   - `anthropic` (optional)
   - `openai` (optional)
   - `other` (`map[string]string`, provider -> credential)
4. Resolve duplicates by precedence using explicit numeric source priorities (higher wins), with first-defined source winning ties.
5. Emit zero or more env assignment lines to stdout.

No credentials found is a success case (exit code 0, empty stdout).

## Local Discovery Matrix

All paths are resolved from the effective home directory (`--homedir` when provided, otherwise OS home).

Claude Code API (first matching file and field wins):

- files in order:
  - `~/.claude.json.api`
  - `~/.claude.json`
- fields in order:
  - `primaryApiKey`
  - `apiKey`
  - `anthropicApiKey`
  - `customApiKey`
- accepted only when key starts with `sk-ant-`

Claude OAuth (skipped with `--no-oauth`):

- files in order:
  - `~/.claude/.credentials.json`
  - `~/.claude-oauth-credentials.json`
- JSON path:
  - `claudeAiOauth.accessToken`
  - optional `claudeAiOauth.expiresAt` (RFC3339); expired tokens ignored

Codex:

- file: `~/.codex/auth.json`
- API key: `OPENAI_API_KEY`
- OAuth (optional): `tokens.access_token`

OpenCode:

- file: `~/.local/share/opencode/auth.json`
- top-level object keyed by provider name
- provider entry:
  - `type = "api"` -> `key`
  - `type = "oauth"` -> `access`, optional `expires` epoch millis (expired tokens ignored)
- providers `anthropic` and `openai` map to dedicated slots; others map to generic provider output

Amp:

- file: `~/.amp/config.json`
- first non-empty field wins:
  - `anthropicApiKey`
  - `anthropic_api_key`
  - `apiKey`
  - `api_key`
  - `accessToken`
  - `access_token`
  - `token`
  - `auth.anthropicApiKey`
  - `auth.apiKey`
  - `auth.token`
  - `anthropic.apiKey`
  - `anthropic.token`

## Output Mapping

Anthropic:

- `ANTHROPIC_API_KEY=<value>`
- `CLAUDE_API_KEY=<value>`

OpenAI:

- `OPENAI_API_KEY=<value>`
- `CODEX_API_KEY=<value>`

Other providers:

- `<PROVIDER>_API_KEY=<value>`
- normalize provider name as:
  - uppercase
  - replace `-` with `_`

Output format:

- Default: `KEY=VALUE`
- With `--export`: `export KEY=VALUE`
- Lines must be deterministic and sorted by key for stable test output.
- Values must be shell-escaped so `eval "$(amika auth extract --export)"` is safe.

## Error Handling and Exit Codes

- `stdout`: env assignments only
- `stderr`: diagnostics for unexpected failures only
- Exit code:
  - `0` on success (including no credentials found)
  - non-zero on unexpected errors (I/O, parse failures, unsupported data format)

Implementation note:

- Use `cmd.SilenceUsage = true` and `cmd.SilenceErrors = true` in Cobra handler (matches existing non-interactive command behavior).

## Security Requirements

- Never print secret values to stderr/logs.
- Never write discovered credentials to disk.
- Redact secret values in diagnostics.
- Restrict file discovery to provided `home_dir` (or user home) and known config paths.

## Implementation Plan

1. Add top-level `auth` command and `extract` subcommand in `cmd/amika`.
2. Add flags: `--export`, `--homedir`, `--no-oauth`.
3. Implement discovery options and wire discovery engine invocation.
4. Implement provider normalization + env var mapping.
5. Implement deterministic, shell-safe rendering to stdout.
6. Return success unless discovery fails unexpectedly.

## Tests

Unit tests:

- provider normalization (`foo-bar` -> `FOO_BAR`)
- env mapping for Anthropic/OpenAI aliases and other providers
- deterministic output sort order
- shell escaping behavior for edge characters

Integration tests:

- temp `home_dir` fixture discovery flow
- `--no-oauth` excludes OAuth-derived credentials
- `--export` prefixes all emitted lines
- no credentials found returns exit code 0 with empty stdout

## Documentation

- Update CLI docs with `auth extract` usage and flags.
- Add `eval` example:

```bash
eval "$(amika auth extract --export)"
```

- Add quickstart/FAQ note for using locally discovered credentials in sandbox sessions.

## Dependencies

- Existing Cobra command framework
- Credential discovery engine module (new or existing internal package)

## Future Considerations

- `--provider <name>` filter for selective export.
- `--format json` for machine-to-machine integrations.
- Optional warnings for conflicting credentials across sources.

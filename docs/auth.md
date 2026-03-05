# Credential Discovery

`amika auth extract` discovers locally stored API credentials from multiple coding agent tools and prints them as shell environment assignments.

## Quick Start

```bash
# See what credentials Amika can find
amika auth extract

# Export into your current shell
eval "$(amika auth extract --export)"

# Skip OAuth token sources
amika auth extract --no-oauth
```

## Supported Sources

Amika scans the following credential sources, in priority order (highest first):

| Priority | Source          | ID                | File(s)                                                           | Providers                  |
| -------- | --------------- | ----------------- | ----------------------------------------------------------------- | -------------------------- |
| 500      | Claude API key  | `claude_api`      | `~/.claude.json.api`, `~/.claude.json`                            | Anthropic                  |
| 400      | Claude OAuth    | `claude_oauth`    | `~/.claude/.credentials.json`, `~/.claude-oauth-credentials.json` | Anthropic                  |
| 300      | Codex           | `codex`           | `~/.codex/auth.json`                                              | OpenAI                     |
| 290      | Amika env cache | `amika_env_cache` | `${XDG_CACHE_HOME}/amika/env-cache.json`                          | Any                        |
| 280      | Amika keychain  | `amika_keychain`  | `${XDG_DATA_HOME}/amika/keychain.json`                            | Any                        |
| 270      | Amika OAuth     | `amika_oauth`     | `${XDG_STATE_HOME}/amika/oauth.json`                              | Any                        |
| 200      | OpenCode        | `opencode`        | `~/.local/share/opencode/auth.json`                               | Any (per-provider entries) |
| 100      | Amp             | `amp`             | `~/.amp/config.json`                                              | Anthropic                  |

When multiple sources provide a credential for the same provider, the highest-priority source wins.

## Output Format

Credentials are output as shell variable assignments:

```
ANTHROPIC_API_KEY='sk-ant-...'
CLAUDE_API_KEY='sk-ant-...'
OPENAI_API_KEY='sk-...'
CODEX_API_KEY='sk-...'
```

With `--export`:

```
export ANTHROPIC_API_KEY='sk-ant-...'
export CLAUDE_API_KEY='sk-ant-...'
export OPENAI_API_KEY='sk-...'
export CODEX_API_KEY='sk-...'
```

Anthropic credentials are output as both `ANTHROPIC_API_KEY` and `CLAUDE_API_KEY`. OpenAI credentials are output as both `OPENAI_API_KEY` and `CODEX_API_KEY`.

## Provider Canonicalization

Provider names are normalized before deduplication:

- `claude`, `anthropic` → `anthropic`
- `codex`, `openai` → `openai`
- Other providers are lowercased, with separators normalized to hyphens

## OAuth Token Handling

OAuth sources (`claude_oauth`, `amika_oauth`, Codex OAuth, OpenCode OAuth) are included by default. Use `--no-oauth` to skip them.

OAuth tokens with an `expiresAt` or `expires` timestamp are skipped if expired.

## Flags

| Flag               | Default | Description                                           |
| ------------------ | ------- | ----------------------------------------------------- |
| `--export`         | `false` | Prefix each line with `export`                        |
| `--homedir <path>` | `$HOME` | Override home directory used for credential discovery |
| `--no-oauth`       | `false` | Skip OAuth credential sources                         |

# Authentication

## Login

`amika auth login` authenticates with Amika using a device authorization flow.

### Quick Start

```bash
# Log in (opens browser)
amika auth login

# Check login status
amika auth status

# Log out
amika auth logout
```

### How It Works

1. The CLI requests a device code from Amika.
2. A user code is displayed and the browser opens for you to authorize.
3. The CLI polls Amika until you complete authorization.
4. The session (access token, refresh token, email, org) is saved to `${XDG_STATE_HOME}/amika/workos-session.json`.
5. Access tokens are automatically refreshed when they are within 60 seconds of expiry.

### Session Storage

The session file is stored at `~/.local/state/amika/workos-session.json` by default (following XDG Base Directory conventions). File permissions are set to `0600`.

The path can be overridden with the `AMIKA_STATE_DIRECTORY` environment variable.

### Related Commands

| Command             | Description                               |
| ------------------- | ----------------------------------------- |
| `amika auth status` | Show current login status (email and org) |
| `amika auth logout` | Remove the saved session                  |

### Environment Variables

| Variable                 | Default                 | Description                                                                                                       |
| ------------------------ | ----------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `AMIKA_API_URL`          | `https://app.amika.dev` | Override the remote API base URL. Used by sandbox commands when operating on remote sandboxes                     |
| `AMIKA_WORKOS_CLIENT_ID` |                         | Override the default WorkOS client ID. If you change `AMIKA_API_URL`, you likely need to update this variable too |

---

## Credential Discovery

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

---

## Remote Credential Management

For remote sandboxes, you can push Claude Code credentials to the Amika secrets store and have them automatically injected at sandbox creation time. This avoids manual authentication inside the sandbox.

See [secrets.md](secrets.md) for the `amika secret claude push/list/delete` workflow.

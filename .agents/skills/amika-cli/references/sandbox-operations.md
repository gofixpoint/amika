# Sandbox lifecycle, agents, auth, and secrets

## Authentication

Credentials resolve in this order:

1. `AMIKA_API_KEY`, preferred for CI and headless work.
2. A stored API key written by `amika auth login --api-key-file`.
3. A browser session written by `amika auth login`.

```bash
amika auth status
amika auth login --api-key-file ./key.txt
amika auth logout
```

Do not invoke browser login in an unattended environment.

## Creating sandboxes

Without `--git` or `--no-git`, creation detects the repository containing the
current directory and checks out a clean clone in the sandbox. Uncommitted work
does not carry over.

```bash
amika sandbox create --no-git -o json
amika sandbox create --name dev \
  --git https://github.com/octocat/Hello-World.git --branch develop
amika sandbox create --branch main --new-branch bugfix-1
amika sandbox create --snapshot amika-mono-base
```

Use `amika sandbox create --help` for the current flags, including preset,
size, environment, setup, repository, snapshot, and credential options.

## Agent credentials and secrets

Push agent credentials before selecting them for a sandbox:

```bash
amika secret claude push
amika secret codex push
amika sandbox create --agent-credential claude=personal-oauth
amika sandbox create --agent-credential-type claude=oauth
amika sandbox create --no-agent-credential codex
```

`--secret env:ANTHROPIC_API_KEY=my-claude-key` maps an environment variable to
a secret already stored under `my-claude-key`; it does not pass a literal secret
value.

## Driving an agent

`amika send` is the programmatic entry point for remote agent chats. Without
`--session-id` or `--sandbox`, it creates a sandbox and starts a chat. It uses
the organization's default agent, falling back to Claude; pass `--agent claude`
or `--agent codex` to choose explicitly.

```bash
amika send "Add tests for the auth module"
printf 'Fix the failing tests\n' | amika send
amika send --sandbox my-sandbox "Refactor the API layer"
amika send --session-id <id> "Continue the refactor"
amika send "Summarize this repo" -o json
```

In JSON output, check `is_error`; a completed request can still contain an agent
failure. Use `--session-id <id>` to continue a chat or `--new-session` with
`--sandbox` to start another chat in an existing sandbox. When `amika send`
creates a sandbox, it auto-detects the current git repository; use `--git` or
`--no-git` to override that behavior.

The agent runs with permission prompts disabled inside the sandbox, so prompts
execute unsupervised there.

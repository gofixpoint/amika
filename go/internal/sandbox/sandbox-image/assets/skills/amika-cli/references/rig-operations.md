# Rig lifecycle, hosts, agents, auth, and secrets

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

## Naming a rig

Wherever a command takes a rig, as a positional `<rig>` or `--rig`, pass its
name or id. A value that is one rig's id and another rig's name is refused;
pin the field with `name=<name>` or `id=<id>`. `_self` is the current rig.

## Creating rigs

Without `--git` or `--no-git`, creation detects the repository containing the
current directory and checks out a clean clone in the rig. Uncommitted work
does not carry over.

```bash
amika rig create --no-git -o json
amika rig create dev \
  --git https://github.com/octocat/Hello-World.git --branch develop
amika rig create --branch main --new-branch bugfix-1
amika rig create --snapshot my-project-base
```

Use `amika rig create --help` for the current flags, including preset,
size, environment, setup, repository, snapshot, and credential options.

## The organization's own hosts

An organization can register hosts of its own (bring-your-own-compute). A rig
runs on Amika Cloud unless `--host` names one of them, by hostname or id.
There is no `--host` value that selects Amika Cloud; omit the flag. With
`--host`, `--size` names one of that host's own sizes, and `--snapshot` is
refused.

```bash
amika host list                       # HOSTNAME, TRANSPORT, URL, SIZES
amika hosts list                      # "hosts" is an alias for "host"
amika host list -o json               # ids, timestamps, per-size resources
amika host get alpha.lan              # the sizes that host offers
amika rig create --host alpha.lan --size small
amika host delete alpha.lan --force   # refused while rigs still run on it
```

Hosts register themselves when `amika-hostd up` runs on the machine, which is
also where the secret lives, so there is no way to add one from this CLI. A
host's TRANSPORT says how to read a `-` in its URL. A `listen` host showing
`-` has not finished registering and cannot take rigs; a `tunnel` host always
shows `-`, because Amika assigns its address and there is nothing to
register, so it says nothing about whether the host is ready.

## Agent credentials and secrets

Push agent credentials before selecting them for a rig:

```bash
amika secret claude push
amika secret codex push
amika rig create --agent-credential claude=personal-oauth
amika rig create --agent-credential-type claude=oauth
amika rig create --no-agent-credential codex
```

`--secret env:ANTHROPIC_API_KEY=my-claude-key` maps an environment variable to
a secret already stored under `my-claude-key`; it does not pass a literal secret
value.

## Driving an agent

`amika send` is the programmatic entry point for remote agent chats. Without
`--session-id` or `--rig`, it creates a rig and starts a chat. It uses
the organization's default agent, falling back to Claude; pass `--agent claude`
or `--agent codex` to choose explicitly.

```bash
amika send "Add tests for the auth module"
printf 'Fix the failing tests\n' | amika send
amika send --rig my-rig "Refactor the API layer"
amika send --session-id <id> "Continue the refactor"
amika send "Summarize this repo" -o json
amika send --agent claude --model fable --effort max "Plan the migration"
```

In JSON output, check `is_error`; a completed request can still contain an agent
failure. Use `--session-id <id>` to continue a chat or `--new-session` with
`--rig` to start another chat in an existing rig. When `amika send`
creates a rig, it auto-detects the current git repository; use `--git` or
`--no-git` to override that behavior.

`--model` and `--effort` set the chat's model and reasoning effort from that
message on, and the chat keeps them; omit both to inherit (a new chat starts on
the org's default, else the server's default model and the agent's own default
effort). Claude models: `fable`, `opus`, `sonnet`, `haiku`; Codex models:
`gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-5.5`, `gpt-5.2`. Effort
is `low`, `medium`, `high`, `xhigh`, or `max` (Codex stops at `xhigh`). The
server validates both against the agent and returns a 400 naming the rejected
field (and, for a value it does not know at all, the values it accepts), so
trust that error over this list if the two disagree.

The agent runs with permission prompts disabled inside the rig, so prompts
execute unsupervised there.

---
name: amika-cli
description: "Drive the `amika` CLI to create, inspect, and operate Amika sandboxes non-interactively. Use when a task involves `amika sandbox`, `amika auth`, `amika secret`, `amika service`, `amika snapshot`, or `amika scp` — creating or deleting a sandbox, running a coding agent inside one, SSHing or copying files into one, pushing credentials, or scripting any of the above with JSON output."
---

# Using the `amika` CLI

`amika` manages **sandboxes**: containerized dev environments with a git repo
checked out, credentials injected, and optionally a coding agent (`claude`,
`codex`) running inside. Drive it non-interactively, with parseable output, and
without hanging on a prompt.

Everything here assumes remote sandboxes on the Amika API, the CLI's default
target. `amika <command> --help` is authoritative and matches the installed
binary; read it before relying on a flag from this document. Product docs:
<https://docs.amika.dev/>.

## Authentication

Credentials resolve per request, in this order:

1. `AMIKA_API_KEY` env var — **use this in CI and other headless contexts**
2. A stored API key file (written by `amika auth login --api-key-file`)
3. A browser-authed session (written by `amika auth login`)

```bash
amika auth status                          # who am I / which org
amika auth login                           # opens a browser — NOT headless-safe
amika auth login --api-key-file ./key.txt  # store a key instead, no browser
vault kv get -field=key … | amika auth login --api-key-file -   # from stdin
amika auth logout
```

Without credentials, commands fail with a `not logged in` error. In an
unattended run, export `AMIKA_API_KEY`; never invoke the browser flow.

## Running it non-interactively

Four rules.

**1. Ask for JSON.** `-o json` (compact, for `jq`) or `-o json-pretty`. Human
progress text and subprocess chatter go to stderr, so stdout is pure JSON.

```bash
name=$(amika sandbox create --no-git -o json | jq -r .name)
amika sandbox list -o json | jq -r '.[].name'
```

Output shapes:

- Most list commands: a bare JSON array (`[]` when empty, never `null`).
- `snapshot list`: `{"items": [...]}`, matching the API schema.
- Batch mutations (`start`/`stop`/`delete` over several names): an array of
  `{name, status, error?}`. Check it for per-item failures rather than trusting
  the exit code alone.

**2. Pass the confirmation flag** on commands that prompt. JSON mode never
prompts, so such a command errors instead of asking. Supply it up front:

| Command           | Flag                                                         |
|-------------------|--------------------------------------------------------------|
| `snapshot create` | `--no-interactive` (then `--mode` and `--name` are required) |
| `snapshot delete` | `--force` / `-f`                                             |
| `service delete`  | `--force` / `-f`                                             |

`sandbox create` and `sandbox delete` do not prompt.

**3. Don't ask for JSON from commands that can't produce it.** These reject
`-o json`/`-o json-pretty` outright:

- `sandbox connect`, `sandbox code`, `sandbox create --connect` — they open a shell or editor
- `sandbox ssh` without `-- <command>` — interactive session
- `auth login` without `--api-key-file` — browser flow
- `secret extract`, `secret push` — they print a masked credential table and prompt

`sandbox ssh` and `scp` reject `--output` entirely: both delegate to the system
`ssh`/`scp`, which stream their own output. (`scp` still forwards its own short
`-o` for `ssh_config` overrides.)

`secret push` and `secret extract --push` always ask `[y/N]` on stdin and have
no bypass flag, so pipe the answer in: `echo y | amika secret push KEY=value`.

**4. Don't launch an interactive session you can't steer.** `sandbox connect`,
`sandbox code`, and bare `sandbox ssh <name>` block on a TTY and hang forever in
a plain tool call. Use `amika sandbox ssh <name> -- <command>` to run something
and get output back.

Exception: if you can drive a terminal — a tmux session or pane you can send
keys to and capture from — an interactive session is fine, and is how to use a
REPL or a long-running TUI in the sandbox. Launch it into that pane, not into a
blocking call.

Errors go to stderr and exit non-zero (`1`).

## Command map

| Command                               | What it does                                                                                 |
|---------------------------------------|----------------------------------------------------------------------------------------------|
| `sandbox create`                      | Create a sandbox; auto-detects the git repo containing the cwd                               |
| `sandbox list` (`ls`)                 | List sandboxes; `-l` adds columns                                                            |
| `sandbox start` / `stop`              | Resume / halt without deleting; both take multiple names                                     |
| `sandbox delete` (`rm`)               | Delete sandboxes; multiple names                                                             |
| `sandbox agent-send`                  | Send a prompt to a coding agent running inside a sandbox                                     |
| `sandbox ssh`                         | SSH in, or run one command; `--print` emits the connection string; `--revoke` revokes access |
| `sandbox connect`                     | Interactive shell (`--shell`, default `zsh`), starting at `/home/amika`                      |
| `sandbox code`                        | Open the sandbox in Cursor / Claude Desktop / Codex over SSH                                 |
| `scp`                                 | Copy files to/from sandboxes; wraps the system `scp`                                         |
| `secret push` / `extract`             | Push arbitrary secrets, or discover local credentials                                        |
| `secret claude` / `secret codex`      | `push` / `list` / `delete` agent credentials for injection                                   |
| `service create` / `list` / `delete`  | Manage named port-backed services on a sandbox                                               |
| `snapshot create` / `list` / `delete` | Capture a running sandbox to fork later                                                      |
| `auth login` / `status` / `logout`    | Authentication                                                                               |

## Creating a sandbox

With no `--git`/`--no-git`, the repo containing the cwd is auto-detected and
checked out at `/home/amika/workspace/<repo>` as a **clean clone** (uncommitted
work is not carried over). An agent running from inside a repo silently gets
that repo unless it says otherwise.

```bash
# Bare sandbox, no repo, scriptable
amika sandbox create --no-git -o json

# Named, from an explicit repo and branch
amika sandbox create --name dev --git https://github.com/octocat/Hello-World.git \
  --branch develop

# New branch off an existing one
amika sandbox create --branch main --new-branch bugfix-1

# Inject a secret and fork from a snapshot
amika sandbox create --secret env:ANTHROPIC_API_KEY=my-claude-key \
  --snapshot amika-mono-base
```

Create flags: `--name` (auto-generates a `{color}-{city}` name if omitted),
`--preset`, `--size` (`xs`/`m`/`l`/`xl`, default `m`), `--env KEY=VALUE`,
`--secret env:FOO=SECRET_NAME`, `--snapshot`, `--branch` / `--new-branch`,
`--setup-script` / `--no-setup`, `--github-auth-mode`, and the
`--agent-credential*` flags below.

Mutually exclusive pairs that error: `--git`/`--no-git`,
`--no-setup`/`--setup-script`, and `--agent-credential[-type]` against
`--no-agent-credential` for the same kind.

### Credential injection

Sandboxes get agent credentials from the remote secrets store. Push them first
with `amika secret claude push` / `amika secret codex push`, then pin per
sandbox:

```bash
amika sandbox create --agent-credential claude=personal-oauth
amika sandbox create --agent-credential-type claude=oauth   # by type: oauth | api-key
amika sandbox create --no-agent-credential codex            # inject nothing for this kind
```

## Repo configuration: `.amika/config.toml`

`.amika/config.toml` at the repo root declares sandbox defaults, so
collaborators get the same environment without passing flags. Settings resolve
by first non-empty value: **CLI flags > UI settings > this file > built-in
defaults**. In a multi-repo sandbox only the primary repo's config applies.

```toml
[lifecycle]
setup_script = ".amika/setup.sh"

[services.web]
port = 3000
url_scheme = "http"

[sandbox]
preset = "coder"
size = "m"

[env]
NODE_ENV = "development"
API_KEY = { secret = "my-api-key" }
```

Sections: `[lifecycle]` (setup/start scripts), `[services.<name>]` (ports and
URL scheme), `[sandbox]` (preset, size, snapshot), `[env]` (variables and
secret references), `[filesystem]` (extra repos to clone), and
`[agent_credentials]` (per-agent defaults).

Prefer editing this file over one-off flags — it is version-controlled and
reviewable in a PR. Full reference:
<https://docs.amika.dev/guides/config-toml> and
<https://docs.amika.dev/guides/configuration>.

## Driving an agent inside a sandbox

`sandbox agent-send` is the main programmatic entry point. `--agent` accepts
`claude` (default) or `codex` — nothing else.

```bash
# Synchronous: waits, streams the response
amika sandbox agent-send my-sandbox "Add unit tests for the auth module"

# From stdin
echo "Fix the failing tests" | amika sandbox agent-send my-sandbox

# Fire and forget
amika sandbox agent-send my-sandbox "Refactor the API layer" --no-wait

# Structured, for a script
amika sandbox agent-send my-sandbox "Summarize this repo" -o json
```

In **text** mode the session id goes to stderr as `session_id: <id>` *before*
the response, keeping stdout the pure agent output. In **JSON** mode you get one
object on stdout:

```json
{ "sandbox": "...", "agent": "claude", "status": "completed",
  "response": "...", "session_id": "...", "agent_session_id": "...",
  "is_error": false, "is_new_session": true, "cost_usd": 0.01 }
```

`status` is `"sent"` for `--no-wait` and `"completed"` otherwise. **Check
`is_error`** — a `completed` send whose agent errored sets it true and exits
non-zero. Resume a session with `--session-id <id>`, or force a fresh one with
`--new-session`.

`--workdir` defaults to `$AMIKA_AGENT_CWD`, which `sandbox create` sets to the
checked-out repo path.

The agent CLIs run with permission prompts disabled inside the sandbox
(`--dangerously-skip-permissions` for Claude,
`--dangerously-bypass-approvals-and-sandbox` for Codex). That is the point of
the sandbox, but anything you send executes unsupervised in there.

## Running commands and copying files

```bash
amika sandbox ssh my-sandbox -- ls -la          # run a command, get output
amika sandbox ssh -t my-sandbox -- top          # force a PTY
amika sandbox ssh --print my-sandbox            # print the connection string
amika sandbox ssh my-sandbox --revoke           # revoke SSH access
```

`amika scp` forwards every argument to the system `scp`, so `-r`, `-p`, `-C`,
`-v`, `-o Option=value` all work. Path forms:

| Form                              | Meaning                                                                        |
|-----------------------------------|--------------------------------------------------------------------------------|
| `PATH`                            | Local path                                                                     |
| `NAME[:PATH]`                     | Path in sandbox `NAME`; relative is under `/home/amika`, absolute is verbatim  |
| `sbox://NAME[/PATH]`              | Same, URI form; `PATH` is absolute, `~` is home, a `/` in `NAME` must be `%2F` |
| `scp://[user@]host[:port][/path]` | An arbitrary SSH host                                                          |

A bare `host:path` **always** names a sandbox — reach a real SSH host only via
an `scp://` URI.

```bash
amika scp ./local.txt my-sandbox:local.txt
amika scp -r my-sandbox:/srv/out ./out
amika scp my-sandbox:/data.csv scp://user@host:22/tmp/data.csv
amika scp --print ./a.txt my-sandbox:a.txt      # show the resolved scp command
```

Sandbox↔sandbox and sandbox↔external copies are not supported yet; go through
the local machine in two steps.

## Snapshots and services

```bash
# Capture a sandbox to fork from later
amika snapshot create --sandbox my-sandbox --no-interactive \
  --mode scrub_and_delete --name my-base
amika snapshot list -o json | jq -r '.items[].name'   # note the envelope
amika snapshot delete my-base --force

# Expose a port as a named service
amika service create --sandbox my-sandbox --name web --port 3000 --url-scheme https
amika service list --sandbox-name my-sandbox
amika service delete --sandbox my-sandbox --name web -f
```

`--mode` is `scrub_and_delete` (removes injected secrets) or `full`. Prefer
`scrub_and_delete` unless you have a reason to bake credentials into an image
others can fork.

Services declared in `.amika/config.toml` are created with the sandbox; use
`service create` for ones you add afterward.

## Environment variables

| Variable                          | Effect                                                                                                              |
|-----------------------------------|---------------------------------------------------------------------------------------------------------------------|
| `AMIKA_API_KEY`                   | Bearer token for the API; beats the stored key and session. The headless auth path                                  |
| `AMIKA_API_URL`                   | API base URL (default `https://app.amika.dev`)                                                                      |
| `AMIKA_STATE_DIRECTORY`           | CLI state dir (default `$XDG_STATE_HOME/amika`, else `~/.local/state/amika`) — holds the session and stored API key |
| `AMIKA_AGENT_CWD`                 | Set inside the sandbox to the checked-out repo; the default `agent-send --workdir`                                  |
| `AMIKA_OPEN_CLAUDE_CODEX_SUPPORT` | Set `true` to unlock `sandbox code --editor=claude\|codex`                                                           |

## Gotchas

- Git auto-detection is on by default and clones clean; pass `--no-git` to opt out.
- An `agent-send` failure is reported twice: the JSON with `"is_error": true`
  goes to stdout first, *then* the command exits non-zero. Read the object.
- `snapshot list` returns `{"items": []}`, unlike every other list command.
- `--secret` takes a secret *name*, not a value — push it with `amika secret push` first.

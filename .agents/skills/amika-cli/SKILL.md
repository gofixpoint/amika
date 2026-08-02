---
name: amika-cli
description: "Drive the `amika` CLI to create, inspect, and operate Amika sandboxes non-interactively. Use when a task involves `amika sandbox`, `amika auth`, `amika secret`, `amika service`, `amika snapshot`, `amika volume`, or `amika scp` — creating or deleting a sandbox, running a coding agent inside one, SSHing or copying files into one, pushing credentials, or scripting any of the above with JSON output."
---

# Using the `amika` CLI

`amika` manages **sandboxes**: containerized dev environments with a git repo
mounted, credentials injected, and optionally a coding agent (`claude`, `codex`)
running inside. This skill covers driving it from an agent — that is,
non-interactively, with parseable output, and without hanging on a prompt.

`amika <command> --help` is authoritative and always matches the installed
binary. Read it before relying on a flag from this document. In the
`gofixpoint/amika` repo, `docs/cli-reference.md` has longer prose on individual
flags; this skill covers the operating model and the agent-safe usage rules
that reference does not.

Check what you're driving first:

```bash
amika version   # prints version, commit, build date
```

## The one thing to get right: local vs remote

Every sandbox command targets **either** local Docker **or** the remote Amika
API — never both, and there is no merged view.

| Invocation | Target |
| ---------- | ------ |
| *(no flag)* | **Remote** — this is the default |
| `--remote`  | Remote (explicit; same as the default) |
| `--local`   | Local Docker daemon on this machine |

The default being remote surprises people. `amika sandbox list` with no flags
hits the API and requires login; it will not show your local Docker sandboxes.
Pass `--local` for those. Anything in older docs claiming the default depends on
login state, or that both are listed at once, is stale — `runmode.Resolve` only
looks at `--local`.

`--local`/`--remote` are persistent flags on `amika sandbox` and `amika service`,
so they go anywhere after the subcommand.

### What only works in one mode

| Only remote | Only local |
| ----------- | ---------- |
| `sandbox ssh`, `sandbox code`, and `scp` sandbox operands | `sandbox create --no-clean` |
| `sandbox create --secret`, `--snapshot`, `--github-auth-mode` | |
| `service create`, `service delete` | |
| all of `snapshot`, all of `secret` | |
| `sandbox agent-send --session-id`, `--new-session` | |

`--size` (`xs`/`m`/`l`/`xl`) is accepted everywhere but only meaningful remotely.

## Authentication

Remote commands need credentials. Resolution order, checked per request:

1. `AMIKA_API_KEY` env var — **use this in CI and other headless contexts**
2. A stored API key file (written by `amika auth login --api-key-file`)
3. A WorkOS browser session (written by `amika auth login`)

```bash
amika auth status                          # who am I / which org
amika auth login                           # device flow, opens a browser — NOT headless-safe
amika auth login --api-key-file ./key.txt  # store a key instead, no browser
vault kv get -field=key … | amika auth login --api-key-file -   # from stdin
amika auth logout
```

Missing credentials fail with `not logged in; run "amika auth login" or use --local`.
If you hit that inside an automated run, either export `AMIKA_API_KEY` or switch
to `--local` — do not try to run the device flow.

## Running it non-interactively

This is the part that breaks agents. Follow all four rules.

**1. Ask for JSON.** `-o json` (compact, for `jq`) or `-o json-pretty`. Human
progress text and subprocess chatter go to stderr, so stdout is pure JSON.

```bash
name=$(amika sandbox create --no-git -o json | jq -r .name)
amika sandbox list -o json | jq -r '.[].name'
```

Most list commands emit a bare JSON array (`[]` when empty, never `null`).
`snapshot list` is the exception: it emits `{"items": [...]}`, matching the API
schema. Batch mutations (`start`/`stop`/`delete` over several names) emit an
array of `{name, status, error?}` — a per-item failure shows up there, so check
it rather than trusting the exit code alone.

**2. Pass the confirmation flag.** In JSON mode the CLI never prompts, so a
command that would have asked errors out instead. Supply the flag up front:

| Command | Flag |
| ------- | ---- |
| `sandbox create` (with mounts) | `--yes` |
| `sandbox delete` | `--force` |
| `snapshot delete`, `service delete` | `--force` / `-f` |
| `snapshot create` | `--no-interactive` (then `--mode` and `--name` are required) |
| `volume delete` (when referenced) | `--force` |

**3. Don't ask for JSON from commands that can't produce it.** These reject
`-o json`/`-o json-pretty` outright:

- `sandbox connect`, `sandbox code`, `sandbox create --connect` — they open a shell or editor
- `sandbox ssh` without `-- <command>` — interactive session
- `auth login` without `--api-key-file` — browser flow
- `secret extract`, `secret push` — they print a masked credential table and prompt

`sandbox ssh` and `scp` reject `--output` entirely, in any mode: both delegate to
the system `ssh`/`scp`, which stream their own output. (`scp` still forwards its
own short `-o` for `ssh_config` overrides.)

**4. Never launch an interactive session.** `sandbox connect`, `sandbox code`,
and bare `sandbox ssh <name>` will hang forever with no TTY. Use
`amika sandbox ssh <name> -- <command>` to run something and get output back.

Errors go to stderr and exit non-zero (`1`).

## Command map

| Command | What it does |
| ------- | ------------ |
| `sandbox create` | Create a sandbox; auto-detects the git repo containing the cwd |
| `sandbox list` (`ls`) | List sandboxes; `-l` adds IMAGE and PORTS columns |
| `sandbox start` / `stop` | Resume / halt without deleting; both take multiple names |
| `sandbox delete` (`rm`) | Delete sandboxes and their containers; multiple names |
| `sandbox agent-send` | Send a prompt to a coding agent running inside a sandbox |
| `sandbox ssh` | SSH in, or run one command; `--print` emits the connection string; `--revoke` revokes access |
| `sandbox connect` | Interactive shell (`--shell`, default `zsh`), starting at `/home/amika` |
| `sandbox code` | Open the sandbox in Cursor / Claude Desktop / Codex over SSH |
| `scp` | Copy files to/from sandboxes; wraps the system `scp` |
| `secret push` / `extract` | Push arbitrary secrets, or discover local credentials |
| `secret claude` / `secret codex` | `push` / `list` / `delete` agent credentials for injection |
| `service create` / `list` / `delete` | Manage named port-backed services on remote sandboxes |
| `snapshot create` / `list` / `delete` | Capture a running sandbox to fork later |
| `volume list` / `delete` | Manage tracked Docker volumes |
| `auth login` / `status` / `logout` | Authentication |
| `version` | Version, commit, build date |

`materialize` also exists (run a script in an ephemeral container, copy outputs
out) but is a hidden command — treat it as unsupported unless asked for by name.

## Creating a sandbox

Git is auto-detected: with no `--git`/`--no-git`, the repo containing the cwd is
mounted at `/home/amika/workspace/<repo>` as a **clean clone** (uncommitted work
is not carried over). Be deliberate about this — an agent running from inside a
repo will silently get that repo unless it says otherwise.

```bash
# Bare sandbox, no repo, scriptable
amika sandbox create --no-git --yes -o json

# Named, from an explicit repo and branch
amika sandbox create --name dev --git https://github.com/octocat/Hello-World.git \
  --branch develop --yes

# New branch off an existing one
amika sandbox create --branch main --new-branch bugfix-1 --yes

# Local, including uncommitted/untracked files
amika sandbox create --local --no-clean --yes

# Remote, with an injected secret and forked from a snapshot
amika sandbox create --remote --secret env:ANTHROPIC_API_KEY=my-claude-key \
  --snapshot amika-mono-base --yes
```

Key flags: `--name` (auto-generates a `{color}-{city}` name if omitted),
`--image` / `--preset` (`coder` or `coder-dind`; mutually exclusive),
`--mount source:target[:mode]`, `--volume name:target[:mode]`,
`--port host:container[/proto]` with `--port-host-ip`, `--env KEY=VALUE`,
`--setup-script` / `--no-setup`, `--size`, `--provider` (only `docker` today).

Mount modes: `ro`, `rw` (writes sync to host), `rwcopy` (default for `--mount` —
a Docker-volume snapshot; **writes do not reach the host**).

Mutually exclusive pairs that error: `--git`/`--no-git`, `--no-clean`/`--no-git`,
`--no-setup`/`--setup-script`, `--image`/`--preset`,
`--agent-credential[-type]`/`--no-agent-credential` for the same kind.

### Credential injection

Sandboxes get agent credentials from the remote secrets store. Push them first
with `amika secret claude push` / `amika secret codex push`, then pin per
sandbox:

```bash
amika sandbox create --agent-credential claude=personal-oauth --yes
amika sandbox create --agent-credential-type claude=oauth --yes   # by type: oauth | api-key
amika sandbox create --no-agent-credential codex --yes            # inject nothing for this kind
```

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

In **text** mode the session id goes to stderr as `session_id: <id>` *before* the
response, keeping stdout the pure agent output. In **JSON** mode you get one
object on stdout:

```json
{ "sandbox": "...", "agent": "claude", "status": "completed",
  "response": "...", "session_id": "...", "agent_session_id": "...",
  "is_error": false, "is_new_session": true, "cost_usd": 0.01 }
```

`status` is `"sent"` for `--no-wait` and `"completed"` otherwise. **Check
`is_error`** — a `completed` send whose agent errored sets it true and exits
non-zero. Resume a remote session with `--session-id <id>`, or force a fresh one
with `--new-session`.

`--workdir` defaults to `$AMIKA_AGENT_CWD`, which `sandbox create` sets to the
mounted repo path.

The agent CLIs run with permission prompts disabled inside the sandbox
(`--dangerously-skip-permissions` for Claude,
`--dangerously-bypass-approvals-and-sandbox` for Codex). That is the point of the
sandbox, but it means anything you send executes unsupervised in there.

## Running commands and copying files

```bash
amika sandbox ssh my-sandbox -- ls -la          # run a command, get output
amika sandbox ssh -t my-sandbox -- top          # force a PTY
amika sandbox ssh --print my-sandbox            # print the connection string
amika sandbox ssh my-sandbox --revoke           # revoke SSH access
```

`amika scp` forwards every argument to the system `scp`, so `-r`, `-p`, `-C`,
`-v`, `-o Option=value` all work. Path forms:

| Form | Meaning |
| ---- | ------- |
| `PATH` | Local path |
| `NAME[:PATH]` | Path in sandbox `NAME`; relative is under `/home/amika`, absolute is verbatim |
| `sbox://NAME[/PATH]` | Same, URI form; `PATH` is absolute, `~` is home, a `/` in `NAME` must be `%2F` |
| `scp://[user@]host[:port][/path]` | An arbitrary SSH host |

A bare `host:path` **always** names a sandbox — reach a real SSH host only via an
`scp://` URI.

```bash
amika scp ./local.txt my-sandbox:local.txt
amika scp -r my-sandbox:/srv/out ./out
amika scp my-sandbox:/data.csv scp://user@host:22/tmp/data.csv
amika scp --print ./a.txt my-sandbox:a.txt      # show the resolved scp command
```

Sandbox↔sandbox and sandbox↔external copies are not supported yet; go through
the local machine in two steps.

## Snapshots, services, volumes

```bash
# Capture a sandbox to fork from later
amika snapshot create --sandbox my-sandbox --no-interactive \
  --mode scrub_and_delete --name my-base
amika snapshot list -o json | jq -r '.items[].name'   # note the envelope
amika snapshot delete my-base --force

# Expose a port on a remote sandbox as a named service
amika service create --sandbox my-sandbox --name web --port 3000 --url-scheme https
amika service list --sandbox-name my-sandbox
amika service delete --sandbox my-sandbox --name web -f

amika volume list
amika volume delete my-volume --force
```

`--mode` is `scrub_and_delete` (removes injected secrets) or `full`. Prefer
`scrub_and_delete` unless you have a reason not to bake credentials into an
image others can fork.

## Environment variables

| Variable | Effect |
| -------- | ------ |
| `AMIKA_API_KEY` | Bearer token for the remote API; beats stored key and session. The headless auth path |
| `AMIKA_API_URL` | Remote API base URL (default `https://app.amika.dev`) |
| `AMIKA_WORKOS_CLIENT_ID` | WorkOS client id for device login; change it alongside `AMIKA_API_URL` |
| `AMIKA_STATE_DIRECTORY` | State dir (default `$XDG_STATE_HOME/amika`, else `~/.local/state/amika`) — holds sandbox/volume/mount state, session, and API key |
| `AMIKA_SANDBOX_PROVIDER` | Override the sandbox provider |
| `AMIKA_PRESET_IMAGE_PREFIX` | Docker image name prefix for presets |
| `AMIKA_AGENT_CWD` | Set inside the sandbox to the mounted repo; the default `agent-send --workdir` |
| `AMIKA_OPEN_CLAUDE_CODEX_SUPPORT` | Set `true` to unlock `sandbox code --editor=claude\|codex` |

Point a whole session at a dev stack by exporting `AMIKA_API_URL` and
`AMIKA_WORKOS_CLIENT_ID` together — there is no config-file equivalent yet.

## Gotchas

- **Remote is the default.** `--local` is the only thing that switches it.
- **`--yes` and `--force` are not optional** in automation; without them a
  prompt either blocks or (in JSON mode) errors.
- **`rwcopy` writes never reach the host.** Use `rw` if you need them to.
- **Git auto-detection is on by default** and clones clean. `--no-git` to opt
  out, `--no-clean` (local only) to carry uncommitted work.
- **An `agent-send` failure is reported twice.** The JSON with
  `"is_error": true` is written to stdout first, *then* the command exits
  non-zero. Read the object rather than only checking the exit code.
- **`snapshot list` returns `{"items": []}`**, unlike every other list command.
- Local sandboxes must use the `docker` provider; other providers error.

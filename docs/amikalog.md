# amikalog

**Your agent sessions, set free.** `amikalog` is an open-source CLI that
captures every Claude Code and Codex session as plain, append-only files on
disk so your past agent work becomes something every future agent, script, and
pipeline can plug into. It ships from the [amika](../README.md) repo but is a
standalone tool: you can use it without anything else from amika.

## The problem: your best agent work is trapped

Your agent just did three hours of brilliant work: explored the codebase, made
decisions, edited files, fixed its own mistakes. All of that is now locked
inside the agent harness, in a format nothing else can use. The next agent
session starts cold. Your CI can't check what the agent actually did. You
can't mine last month's sessions for the patterns that worked or the mistakes
that keep recurring.

Most tooling captures sessions so a *human* can look back at them. That's
useful, but it leaves the real value on the table: sessions are data, and data
wants to be fed *forward* into the next agent run, into guardrails, into
evals.

## The solution: capture once, reuse everywhere

`amikalog` records every agent session as append-only JSON events under a
predictable directory tree on your own disk. It rides the agents' own hook
systems: both Claude Code and Codex can run a command at lifecycle points like
"tool call finished" or "prompt submitted". Each event carries the hook
payload plus the git state it happened in: repo, commit, branch, dirty or
clean. No daemon, no proxy, no change to how you invoke the agent: you run
`amikalog start` once, and from then on the agents record their own activity
on every hook call.

amikalog's job is the capture half: a complete event log with a stable schema,
as ordinary files. Reuse then works at two levels. Locally, the output is just
JSON on disk, so you close the loop with whatever you already have (`jq`, a
script, a cron job, your agent's own file tools). And with `beta:push` and
`beta:fetch`, sessions sync through your org's storage bucket, turning your
team's whole history into a shared filesystem that agents can fetch, search,
and slice wherever they run. Either way, past sessions become something future
runs draw on:

- **Memory** — have a new session read past sessions' event logs in the same
  repo, so agents stop rediscovering the same context.
- **Guardrails** — mine past sessions for the rules your team keeps learning
  the hard way ("always rotate refresh tokens") and write them into the
  instruction files (`CLAUDE.md`, `AGENTS.md`) that future runs load.
- **Evals** — each session is the full sequence of what an agent actually did,
  pinned to the exact commit it did it on. Real sessions make the best test
  cases.

It's agent-agnostic, too: Claude Code and Codex events share one schema, so
anything you build on top works across agents.

## Quick start

Install the latest release binary with the install script, passing
`--component amikalog`:

```bash
curl -fsSL https://raw.githubusercontent.com/gofixpoint/amika/main/install.sh | sh -s -- --component amikalog
```

Pin a specific version with `--install-version` (amikalog is released
independently of `amika`, under tags of the form `amikalog@v*`). To build from
source instead, run `make build-amikalog` (output lands in `dist/amikalog`).

Then turn on capture (once, globally):

```bash
amikalog start
```

That's it. Use Claude Code and Codex exactly as before; every session is now
being recorded. `amikalog stop` undoes it: only the hooks amikalog installed
are removed; unrelated hooks and already-captured events are left alone.

## How capture works

`amikalog start` idempotently installs hook entries into:

- `~/.claude/settings.json` — one entry per Claude Code agent-activity hook
  event (tool use, prompts, permissions, subagents, tasks, turns, context
  compaction, and session lifecycle; purely UI/environment events are omitted
  to keep the log signal-bearing rather than a firehose)
- `~/.codex/hooks.json` — one entry per Codex lifecycle event (honors
  `$CODEX_HOME`)

The hooks are global: they fire in every repository. Capture is best-effort by
design: a failure to record is reported on stderr but never blocks the agent
or alters its behavior.

## Event storage

Events are written under the amika state directory
(`~/.local/state/amika` by default; override with `AMIKA_STATE_DIRECTORY`):

```
<state>/events/{claude,codex}/sessions/<ts>_<session-id>/event_<seq>_<ts>.json
```

Each file is one JSON event and is never modified after being written.
Sessions are ordinary directories you can `grep`, `jq`, sync, or load into a
database. An event records:

| Field        | Description                                                              |
| ------------ | ------------------------------------------------------------------------ |
| `source`     | The agent that fired the hook (`claude` or `codex`)                      |
| `hook_event` | The hook's event name (e.g. `PostToolUse`)                               |
| `session_id` | The agent session the event belongs to                                   |
| `timestamp`  | Capture time (RFC3339 with nanoseconds, UTC)                             |
| `seq`        | The event's position within its session, starting at 0                   |
| `cwd`        | The working directory the hook reported                                  |
| `git`        | Git state of `cwd` (`repo_root`, `commit`, `branch`, `dirty`), or `null` |
| `payload`    | The raw hook payload exactly as the agent provided it                    |

## Sharing sessions with your org (beta)

Local capture is the default and works entirely offline. But sessions get more
valuable when the whole team's land in one place: that's the corpus your
memory, guardrails, and evals draw from. Two beta commands sync the event log
with a storage bucket that the hosted Amika platform (`app.amika.dev`) manages
for your organization. Both authenticate by setting `AMIKA_API_KEY` to an org
API key; no other auth source is consulted.

```bash
amikalog beta:push          # upload not-yet-pushed events
amikalog beta:fetch <dir>   # download the org bucket into <dir>
```

`beta:push` uploads each event file under the object key
`<repo>/<source>/sessions/...`, where `<repo>` comes from the session's
`git.repo_root`. Pushed files are tracked in
`<state>/events/.amikalog-push-state.json`, so repeated runs upload only events
captured since the last push, and re-pushing is idempotent.

`beta:fetch` downloads every object in the org bucket into a local directory,
recreating the bucket's key tree on disk: your whole org's sessions, as
ordinary files.

## Command reference

| Command                     | Description                                                   |
| --------------------------- | ------------------------------------------------------------- |
| `amikalog start`            | Register the amikalog hooks with Claude Code and Codex        |
| `amikalog stop`             | Remove the hooks (already-captured events are kept)           |
| `amikalog beta:push`        | Upload not-yet-pushed events to your org's storage bucket     |
| `amikalog beta:fetch <dir>` | Download the entire org storage bucket into a local directory |
| `amikalog version`          | Print version information                                     |

There is also a hidden `amikalog hook --source claude|codex` command, the
entrypoint the agents' hook systems invoke. It is not meant to be run by hand.

## Environment variables

| Variable                | Purpose                                                       |
| ----------------------- | ------------------------------------------------------------- |
| `AMIKA_STATE_DIRECTORY` | Override the state directory (default `~/.local/state/amika`) |
| `AMIKA_API_KEY`         | Org API key for `beta:push` / `beta:fetch`                    |
| `AMIKA_API_URL`         | Override the API base URL (default `https://app.amika.dev`)   |
| `CODEX_HOME`            | Override the Codex config directory (default `~/.codex`)      |

<p align="center">
  <h1 align="center">clawbox</h1>
  <p align="center"><strong>Multiplayer sandbox and filesystem for your AI agents</strong></p>
  <p align="center">Create and share AI sandboxes, loaded with your files and connected to your apps.</p>
</p>

<p align="center">
  <a href="https://github.com/gofixpoint/clawbox/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-Apache%202.0-blue.svg" alt="License"></a>
  <a href="https://go.dev/"><img src="https://img.shields.io/badge/built%20with-Go-00ADD8.svg" alt="Go"></a>
  <img src="https://img.shields.io/badge/platform-macOS-lightgrey.svg" alt="macOS">
  <img src="https://img.shields.io/badge/status-alpha-orange.svg" alt="Alpha">
</p>

<p align="center">
  <a href="https://withclawbox.com">withclawbox.com</a>
</p>

---

## Why

AI agents like Claude Code and OpenClaw have converged on the best interface for knowledge work: give the agent a computer and let it operate on files. But then you run into two problems:

1. getting the right data onto your sandbox
2. sharing your AI agents or vibe-coded apps with your teammates

So we're built Clawbox: multiplayer sandboxes and a shared filesystem for your AI agents. It started because we wanted to automate our sales pipeline with Claude Code. (Yes, only an engineer would run sales on a POSIX filesystem with a coding agent…)

Clawbox lets you spin up sandboxes on any infra provider, load them with data from your SaaS products and the web, and then share them with your teammates.

Reasons to share with your teammates:

1. your agent vibe-coded an app and you want your coworkers to use it
2. you want to hand off an in-progress agent coding session without losing context
3. your teammate wants to fork your agentic workflow into their own sandbox

## How It Works

1. **Materialize** -- Run scripts that pull data from any source. Outputs land as files in your filesystem repo.
2. **Mount** -- Mount directories into sandboxes with access control (read-only, read-write, overlay).
3. **Work** -- Your agent reads and writes files inside the sandbox. You control what syncs back.
4. **Share** (coming soon) -- at the end, you can share access to your sandbox with your teammates. You can freeze the sandbox, or let them take over or fork it

```
┌──────────────┐      ┌──────────────────────┐      ┌─────────────────┐
│  Your Tools  │ ──── │ Clawbox Filesystem   │ ──── │  Agent Sandbox  │
│              │      │                      │      │                 │
│  HubSpot     │      │  materialize ──> fs  │      │  mounted dirs   │
│  Linear      │      │  scripts, commands   │      │  ro / rw / ovl  │
│  Notion      │      │                      │      │                 │
└──────────────┘      └──────────────────────┘      └─────────────────┘
```

## Quick Start

**Prerequisites:** Go 1.21+, Docker, macOS

Right now, we only support mounting into Docker containers, but we are expanding to support network-mounting filesystems onto any machine.

```bash
# Clone and build
git clone https://github.com/gofixpoint/clawbox.git && cd clawbox
go build -o dist/clawbox ./cmd/clawbox

# Materialize: run a command and capture its output as files
./dist/clawbox materialize --cmd "echo hello > greeting.txt" --destdir /tmp/demo
cat /tmp/demo/greeting.txt

# Create a Docker sandbox with a mounted directory
./dist/clawbox sandbox create --name my-sandbox \
  --mount /tmp/demo:/workspace/data:ro
```

## Example: Sales Pipeline

*We've built some materialization scripts for our own use cases and put them inside `./materialization-scripts`. We're taking pull requests if there's other standard data flows to materialize for agents.*

Because we're big engineering nerds, we run part of our sales workflow in Claude Code. It was a PITA to get the right CRM data to Claude, so we automated it:

```bash
# 1. Materialize CRM data -- a script pulls deals from HubSpot as JSON files
./dist/clawbox materialize \
  --script ./materialization-scripts/pull-hubspot-deals.sh \
  --destdir ./data/deals

# 2. Create a sandbox with the data mounted read-only
./dist/clawbox sandbox create --name sales-agent \
  --mount ./data/deals:/workspace/deals:ro \
  --mount ./output:/workspace/drafts:rw

# 3. Your agent runs inside the sandbox, reads deal files, writes draft emails
# The agent sees /workspace/deals (read-only) and writes to /workspace/drafts

# 4. Review drafts on your host at ./output/
ls ./output/
```

You can also let Claude work off the data on your host computer, without a sandbox:

```bash
# Just work off the data outside the sandbox. Either `cd ./data/deals`,
# or mount it somewhere first:
./dist/clawbox mount ./data/deals ~/workspace/claude/sales --mode rw
```

Run materialization scripts on any cron schedule. Data stays fresh. Agents get
context without copy-paste.

## Commands

### `clawbox materialize`

Execute a script or command and copy outputs to your filesystem. By default, all
scripts run inside isolated sandboxes so they cannot accidentally overwrite
files on your computer.

```bash
# Run a script, copy results to a destination
clawbox materialize --script ./pull-data.sh --destdir ./output

# Run an inline command
clawbox materialize --cmd "curl -s https://api.example.com/data > result.json" --destdir ./output

# Specify which directory to copy from inside the sandbox
clawbox materialize --script ./transform.sh --outdir /app/results --destdir ./output
```

### `clawbox sandbox create|delete|list`

Manage Docker-backed persistent sandboxes with mounted directories.

```bash
# Create a sandbox with mounts
clawbox sandbox create --name dev-sandbox \
  --image ubuntu:latest \
  --mount ./src:/workspace/src:ro \
  --mount ./out:/workspace/out:rw

# List running sandboxes
clawbox sandbox list

# Delete a sandbox
clawbox sandbox delete --name dev-sandbox
```

### `clawbox v0 mount|unmount`

Mount and unmount directories with fine-grained access control.

```bash
# Mount a directory read-only
clawbox v0 mount ./data /mnt/data --mode ro

# Mount with overlay (writes don't affect source)
clawbox v0 mount ./data /mnt/data --mode overlay

# Unmount
clawbox v0 unmount /mnt/data
```

## Roadmap

- [x] Sandboxed script execution with output materialization
- [x] Docker-backed persistent sandboxes
- [x] Filesystem mounts (ro / rw / overlay)
- [ ] Scheduled jobs (cron-style materialization)
- [ ] Built-in connectors (HubSpot, Linear, Notion, Gmail)
- [ ] Linux support
- [ ] Network-mountable filesystem
- [ ] Filesystem versioning and branching
- [ ] Remote sandbox mounting (Modal, E2B, Daytona)

## Status

Clawbox is **alpha software**. It runs on macOS only. APIs and CLI flags will change. We're building in public -- if something breaks or you have ideas, [open an issue](https://github.com/gofixpoint/clawbox/issues). Feedback shapes what we build next.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup and guidelines.

## License

[Apache 2.0](LICENSE)

<p align="center">
  <h1 align="center">amika</h1>
  <p align="center"><strong>The filesystem for your AI agents.</strong></p>
  <p align="center">Pull data from your tools. Mount it into sandboxes. Let your agents work on files.</p>
</p>

<p align="center">
  <a href="https://github.com/gofixpoint/amika/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-Apache%202.0-blue.svg" alt="License"></a>
  <a href="https://go.dev/"><img src="https://img.shields.io/badge/built%20with-Go-00ADD8.svg" alt="Go"></a>
  <img src="https://img.shields.io/badge/platform-macOS-lightgrey.svg" alt="macOS">
  <img src="https://img.shields.io/badge/status-alpha-orange.svg" alt="Alpha">
</p>

<p align="center">
  <a href="https://withamika.com">withamika.com</a>
</p>

---

## Why

AI agents like Claude Code and OpenClaw have converged on the best interface for knowledge work: give the agent a computer and let it operate on files. The problem is getting the right data onto that computer, especially when you're running agents inside ephemeral sandboxes (Daytona, Modal, etc.).

So we built Amika: a filesystem for AI agents. It started because I wanted to automate my sales pipeline with Claude Code. (Yes, only an engineer would run sales on a POSIX filesystem with a coding agent…)

Amika lets you pull scattered data from Hubspot, Linear, wherever, and connect that data to your agent sandboxes, persisting it across sessions. You can also use the data outside sandboxes on your local machine.

**Think of us kind of like Dropbox, but for you AI agents.**

## How It Works

1. **Materialize** -- Run scripts that pull data from any source. Outputs land as files in your filesystem repo.
2. **Mount** -- Mount directories into sandboxes with access control (read-only, read-write, overlay).
3. **Work** -- Your agent reads and writes files inside the sandbox. You control what syncs back.

```
┌──────────────┐      ┌──────────────────────┐      ┌─────────────────┐
│  Your Tools  │ ──── │ Amika Filesystem     │ ──── │  Agent Sandbox  │
│              │      │                      │      │                 │
│  HubSpot     │      │  materialize ──> fs  │      │  mounted dirs   │
│  Linear      │      │  scripts, commands   │      │  ro / rw / rwcopy │
│  Notion      │      │                      │      │                 │
└──────────────┘      └──────────────────────┘      └─────────────────┘
```

## Quick Start

**Prerequisites:** Go 1.21+, Docker, macOS

Right now, we only support mounting into Docker containers, but we are expanding to support network-mounting filesystems onto any machine.

```bash
# Clone and build
git clone https://github.com/gofixpoint/amika.git && cd amika
make build-cli

# Materialize: run a command and capture its output as files
./dist/amika materialize --cmd "echo hello > greeting.txt" --destdir /tmp/demo
cat /tmp/demo/greeting.txt

# Create a Docker sandbox with a mounted directory
# (mode defaults to rwcopy when omitted)
./dist/amika sandbox create --name my-sandbox \
  --mount /tmp/demo:/workspace/data
```

## Example: Sales Pipeline

*We've built some materialization scripts for our own use cases and put them inside `./materialization-scripts`. We're taking pull requests if there's other standard data flows to materialize for agents.*

Because we're big engineering nerds, we run part of our sales workflow in Claude Code. It was a PITA to get the right CRM data to Claude, so we automated it:

```bash
# 1. Materialize CRM data -- a script pulls deals from HubSpot as JSON files
./dist/amika materialize \
  --script ./materialization-scripts/pull-hubspot-deals.sh \
  --destdir ./data/deals

# 2. Create a sandbox with data mounts
./dist/amika sandbox create --name sales-agent \
  --mount ./data/deals:/workspace/deals:ro \
  --mount ./output:/workspace/drafts

# 3. Your agent runs inside the sandbox, reads deal files, writes draft emails
# The agent sees /workspace/deals (read-only) and writes to /workspace/drafts

# 4. Review drafts on your host at ./output/
ls ./output/
```

You can also let Claude work off the data on your host computer, without a sandbox:

```bash
# Just work off the data outside the sandbox. Either `cd ./data/deals`,
# or mount it somewhere first:
./dist/amika mount ./data/deals ~/workspace/claude/sales --mode rw
```

Run materialization scripts on any cron schedule. Data stays fresh. Agents get
context without copy-paste.

## Commands

### `amika materialize`

Execute a script or command in an isolated Docker container and copy outputs to your filesystem.

```bash
# Run a script, copy results to a destination
amika materialize --script ./pull-data.sh --destdir ./output

# Run an inline command
amika materialize --cmd "curl -s https://api.example.com/data > result.json" --destdir ./output

# Run interactively (e.g. launch Claude Code inside a container)
amika materialize -i --cmd claude --mount $(pwd):/workspace
```

### `amika sandbox create|list|connect|delete`

Manage Docker-backed persistent sandboxes with bind mounts and named volumes.

```bash
# Create a sandbox with mounts (mode defaults to rwcopy)
amika sandbox create --name dev-sandbox \
  --mount ./src:/workspace/src:ro \
  --mount ./out:/workspace/out

# Mount the current git repo into the sandbox
amika sandbox create --name dev-sandbox --git

# List, connect, delete
amika sandbox list
amika sandbox connect dev-sandbox
amika sandbox delete dev-sandbox
```

### `amika volume list|delete`

Inspect and delete tracked Docker volumes used by sandboxes.

```bash
amika volume list
amika volume delete my-volume
```

### `amika auth extract`

Discover locally stored credentials from Claude Code, Codex, OpenCode, and Amp.

```bash
amika auth extract
eval "$(amika auth extract --export)"
```

For the full flag reference, see [docs/cli-reference.md](docs/cli-reference.md). For credential discovery details, see [docs/auth.md](docs/auth.md). For preset images, see [docs/presets.md](docs/presets.md).

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

Amika is **alpha software**. It runs on macOS only. APIs and CLI flags will change. We're building in public -- if something breaks or you have ideas, [open an issue](https://github.com/gofixpoint/amika/issues). Feedback shapes what we build next.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup and guidelines.

## License

[Apache 2.0](LICENSE)

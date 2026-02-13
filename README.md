<p align="center">
  <h1 align="center">clawbox</h1>
  <p align="center"><strong>The filesystem for your AI agents.</strong></p>
  <p align="center">Pull data from your tools. Mount it into sandboxes. Let your agents work on files.</p>
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

AI agents work best when they have a filesystem. But getting the right data onto that filesystem is painful.

Your data lives across HubSpot, Linear, Notion, Gmail -- scattered behind APIs and authentication walls. You end up copy-pasting context into prompts or writing bespoke integrations for every workflow.

Ephemeral sandboxes start empty every time. Your agent has no memory of the files it worked with yesterday.

**Clawbox fixes this.** It gives your agents a filesystem that connects to your tools, mounts into sandboxes, and persists across sessions.

## How It Works

1. **Materialize** -- Run scripts that pull data from any source. Outputs land as files on your local filesystem.
2. **Mount** -- Mount directories into Docker sandboxes with access control (read-only, read-write, overlay).
3. **Work** -- Your agent reads and writes files inside the sandbox. You control what syncs back.

```
┌──────────────┐      ┌─────────────────────┐      ┌─────────────────┐
│  Your Tools  │ ──── │ Clawbox Filesystem   │ ──── │  Agent Sandbox  │
│              │      │                      │      │                 │
│  HubSpot     │      │  materialize ──> fs  │      │  mounted dirs   │
│  Linear      │      │  scripts, commands   │      │  ro / rw / ovl  │
│  Notion      │      │                      │      │                 │
└──────────────┘      └─────────────────────┘      └─────────────────┘
```

## Quick Start

**Prerequisites:** Go 1.21+, Docker, macOS

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

Clawbox shines when agents need real data from your tools. Here's how it powers an automated sales workflow:

```bash
# 1. Materialize CRM data -- a script pulls deals from HubSpot as JSON files
./dist/clawbox materialize \
  --script ./scripts/pull-hubspot-deals.sh \
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

Scripts run daily. Data stays fresh. Agents get context without copy-paste.

## Commands

### `clawbox materialize`

Execute a script or command in a sandbox and copy outputs to your filesystem.

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

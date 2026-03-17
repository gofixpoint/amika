<p align="center">
  <h1 align="center">amika</h1>
  <p align="center"><strong>Infra to build your software factory.</strong></p>
  <p align="center">Build background agents that automate software generation. Spin up multiplayer sandboxes pre-loaded with any coding agent.</p>
</p>

<p align="center">
  <a href="https://github.com/gofixpoint/amika/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-Apache%202.0-blue.svg" alt="License"></a>
  <a href="https://go.dev/"><img src="https://img.shields.io/badge/built%20with-Go-00ADD8.svg" alt="Go"></a>
  <img src="https://img.shields.io/badge/status-beta-yellow.svg" alt="Beta">
</p>

<p align="center">
  <a href="https://amika.dev">amika.dev</a>
</p>

---

## What is Amika?

Amika is an open-source CLI and HTTP API for running AI coding agents in sandboxes. Each sandbox comes pre-configured with development tools and agent CLIs — Claude Code, Codex, and OpenCode — ready to go out of the box.

Agent credentials are auto-discovered from your host machine and mounted into every sandbox. Git repos are cloned in with `--git`, and setup scripts let you customize the environment on creation. The REST API (`amika-server`) exposes the same functionality for programmatic access.

This is the same infra pattern used by Ramp, Coinbase, and Stripe for their in-house coding agent platforms.

## Key Features

- **Preset environments** — Ubuntu 24.04 sandboxes with Claude Code, Codex, OpenCode, Python, Node.js, and standard dev tools
- **Credential auto-discovery** — Zero-config agent auth; your Claude Code and Codex API keys and OAuth tokens are found and mounted automatically
- **Git repo mounting** — Clone your repo into a sandbox with `--git` (clean clone by default, or `--no-clean` for uncommitted files)
- **Setup scripts** — Run custom initialization logic on sandbox creation with `--setup-script`
- **Port publishing** — Expose container ports to the host for live previews with `--port`
- **REST API** — `amika-server` exposes all operations as HTTP endpoints with OpenAPI docs at `/docs`

## Quick Start

**Prerequisites:** Go 1.21+, Docker, macOS or Linux

### Install

```bash
git clone https://github.com/gofixpoint/amika.git && cd amika
make build
```

### Create Your First Sandbox

Run this from within a git repo, and the `--git` flag will pick up the repo root and mount the entire repo into your sandbox.

```bash
./dist/amika sandbox create --name my-sandbox --git --connect
```

Inside the sandbox you get a zsh shell at `/home/amika/workspace/{repo}` with your full repo, dev tools, and agent credentials ready.

### Run Claude Code in a Sandbox

Create a sandbox with your git repo and auto-connect to it:

```bash
./dist/amika sandbox create --git --connect
# Inside the sandbox:
claude "Add unit tests for the auth module"
```

### Run Multiple Agents in Parallel

```bash
./dist/amika sandbox create --name task-1 --git
./dist/amika sandbox create --name task-2 --git
./dist/amika sandbox list
```

## How It Works

```
┌────────────────────┐
│   Your Host        │
│                    │     ┌──────────────────────────────────┐
│  Git repo ───────────>   │  Docker Sandbox                  │
│                    │     │                                  │
│  Credentials ────────>   │  /home/amika/workspace/{repo}    │
│  (auto-discovered) │     │  Agent CLIs ready (claude, codex)│
│                    │     │  Dev tools (git, node, python)   │
│  Setup script ───────>   │  setup.sh runs on start     │
│                    │     │                                  │
│  Port 8080 <──────────   │  --port 8080:8080                │
│  (live preview)    │     │                                  │
└────────────────────┘     └──────────────────────────────────┘
```

## Commands Overview

| Command                 | Description                                                                   |
| ----------------------- | ----------------------------------------------------------------------------- |
| `amika sandbox create`  | Create a new Docker sandbox with mounts, presets, and environment config      |
| `amika sandbox list`    | List all tracked sandboxes                                                    |
| `amika sandbox connect` | Attach to a running sandbox with an interactive shell                         |
| `amika sandbox delete`  | Delete sandboxes and optionally their volumes                                 |
| `amika materialize`     | Run a script/command in an ephemeral container and copy outputs files to host |
| `amika volume list`     | List tracked Docker volumes                                                   |
| `amika volume delete`   | Delete tracked Docker volumes                                                 |
| `amika auth extract`    | Discover and print locally stored agent credentials                           |
| `amika-server`          | Start the HTTP API server                                                     |

For the full flag reference, see [docs/cli-reference.md](docs/cli-reference.md).

## HTTP API

Start the server:

```bash
./dist/amika-server
# Listening on :8080
```

OpenAPI documentation is available at `/docs`. The API mirrors the CLI — create sandboxes, run materializations, extract credentials, and manage volumes over HTTP.

See the [endpoint table in docs/cli-reference.md](docs/cli-reference.md#api-endpoints) for the full list of routes.

## Configuration

Amika reads config from both `${XDG_CONFIG_HOME}/amika/config.toml` and `.amika/config.toml`. The schema is shared between the two locations, repo config overrides global config, and environment variables override both.

```toml
[api]
api_url = "https://app.amika.dev"
auth_client_id = "client_..."
```

See [docs/sandbox-configuration.md](docs/sandbox-configuration.md) and [docs/auth.md](docs/auth.md) for details.

## Presets

| Preset            | Image                 | Includes                                                                         |
| ----------------- | --------------------- | -------------------------------------------------------------------------------- |
| `coder` (default) | `amika/coder:latest`  | Ubuntu 24.04, git, zsh, Python 3, Node.js 22, pnpm, Claude Code, Codex, OpenCode |
| `claude`          | `amika/claude:latest` | Ubuntu 24.04, git, zsh, Python 3, Node.js 22, pnpm, Claude Code                  |

Preset images are built automatically on first use from bundled Dockerfiles (one-time build, takes a minute).

Agent credentials are auto-discovered from your host and mounted as read-only snapshots — coding agents authenticate without manual configuration. See [docs/presets.md](docs/presets.md) and [docs/auth.md](docs/auth.md) for details.

## Roadmap

- [x] Docker-backed persistent sandboxes
- [x] Credential auto-discovery and mounting
- [x] Git repo mounting (`--git`)
- [x] Setup scripts (`--setup-script`)
- [x] Port publishing (`--port`)
- [x] REST API with OpenAPI docs
- [x] Linux support
- [ ] Remote providers (Modal, E2B, Daytona)
- [ ] Scheduled sandbox jobs

## Status

Amika is in **beta**. APIs and CLI flags may change. If something breaks or you have ideas, [open an issue](https://github.com/gofixpoint/amika/issues) — feedback shapes what we build next.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup and guidelines.

## License

[Apache 2.0](LICENSE)

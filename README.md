<p align="center">
  <h1 align="center">amika</h1>
  <p align="center"><strong>Infra to build your software factory.</strong></p>
  <p align="center">Build background agents that automate software generation and verification. Spin up multiplayer sandboxes pre-loaded with any coding agent.</p>
</p>

<p align="center">
  <a href="https://github.com/gofixpoint/amika/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-Apache%202.0-blue.svg" alt="License"></a>
  <a href="https://go.dev/"><img src="https://img.shields.io/badge/built%20with-Go-00ADD8.svg" alt="Go"></a>
  <img src="https://img.shields.io/badge/status-beta-yellow.svg" alt="Beta">
</p>

<p align="center">
  <a href="https://amika.dev">amika.dev</a>
  <br />
  <br />
  <a href="https://www.amika.dev">Join Waitlist</a> | <a href="https://docs.amika.dev/">Docs</a> | <a href="https://discord.gg/xDXk4KjGWg">Discord</a>
</p>

---

## What is Amika?

Amika is an open-source CLI and HTTP API for running AI coding agents in sandboxes. Each sandbox comes pre-configured with development tools and agent CLIs — Claude Code, Codex, and OpenCode — ready to go out of the box.

Agent credentials are auto-discovered from your host machine and mounted into every sandbox. Git repos are auto-detected from the current directory (or pointed to with `--git <path|url>`), and setup scripts let you customize the environment on creation. The REST API (`amika-server`) exposes the same functionality for programmatic access.

This is the same infra pattern used by Ramp, Coinbase, and Stripe for their in-house coding agent platforms.

Want it fully managed? [Amika Cloud](https://amika.dev) runs the same agents in remote micro-VMs. See [Amika Cloud](#amika-cloud) below.

## Key Features

- **Preset environments** — Ubuntu 24.04 sandboxes with Claude Code, Codex, OpenCode, Python, Node.js, and standard dev tools
- **Credential auto-discovery** — Zero-config agent auth; your Claude Code and Codex API keys and OAuth tokens are found and mounted automatically
- **Git repo mounting** — Auto-detects the git repo containing your current directory (or pass `--git <path|url>`). Clean clone by default; `--no-clean` includes uncommitted files
- **Setup scripts** — Run custom initialization logic on sandbox creation with `--setup-script`
- **Port publishing** — Expose container ports to the host for live previews with `--port`
- **REST API** — `amika-server` exposes all operations as HTTP endpoints with OpenAPI docs at `/docs`
- **TypeScript SDK** — [`@amika/sdk`](sdk/typescript/README.md) wraps the REST API for programmatic access from Node.js

## Quick Start

**Prerequisites:** Docker, macOS or Linux (Go 1.21+ only needed to build from source)

### Install

Install the latest release binary with the install script:

```bash
curl -fsSL https://raw.githubusercontent.com/gofixpoint/amika/main/install.sh | sh
```

This downloads the release binary, verifies its checksum, and installs `amika` to `/usr/local/bin` (override with `AMIKA_INSTALL_DIR`). Pin a specific version with `--install-version`:

```bash
curl -fsSL https://raw.githubusercontent.com/gofixpoint/amika/main/install.sh | sh -s -- --install-version 0.9.0
```

Once installed, the `amika` binary is on your `PATH` — run commands directly (e.g. `amika sandbox create`).

<details>
<summary>Build from source instead</summary>

Requires Go 1.21+. Build outputs land in `dist/`:

```bash
git clone https://github.com/gofixpoint/amika.git && cd amika
make build
```

When built from source, invoke the binary as `./dist/amika` (the examples below use this form).

</details>

### Create Your First Sandbox

Run this from within a git repo and Amika will auto-detect the repo root and mount the entire repo into your sandbox.

```bash
amika sandbox create --name my-sandbox --connect
```

Inside the sandbox you get a zsh shell at `/home/amika/workspace/{repo}` with your full repo, dev tools, and agent credentials ready.

### Run Claude Code in a Sandbox

Create a sandbox with your git repo and auto-connect to it:

```bash
amika sandbox create --connect
# Inside the sandbox:
claude "Add unit tests for the auth module"
```

### Run Multiple Agents in Parallel

```bash
amika sandbox create --name task-1
amika sandbox create --name task-2
amika sandbox list
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
│  Setup script ───────>   │  setup.sh runs on start          │
│                    │     │                                  │
│  Port 8080 <──────────   │  --port 8080:8080                │
│  (live preview)    │     │                                  │
└────────────────────┘     └──────────────────────────────────┘
```

## Amika Cloud

Everything above runs locally on your own Docker. [Amika Cloud](https://amika.dev) is the managed platform built on the same CLI and API: agents run in isolated micro-VMs instead of local containers, so you can spin up sandboxes without local Docker and run far more in parallel.

Get started by logging in and pushing your credentials once, then create remote sandboxes:

```bash
amika auth login
amika secret claude push --type oauth
amika sandbox create --remote --connect
```

On top of remote sandboxes, the platform adds:

- **Event-driven agents** — kick off agents from Slack, Linear, GitHub, webhooks, Sentry alerts, or a schedule
- **Validation loops** — wire up your test suite, type checker, and linters; agents iterate on failures and only surface passing work for review
- **Live preview URLs** — shareable URLs for any service an agent runs
- **Multiplayer UI** — a shared chat UI with full session transcripts, tool calls, and token costs

[Sign up at](https://www.amika.dev) and follow the [hosted quickstart](https://docs.amika.dev/quickstart).

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
| `amika secret extract`  | Discover locally stored agent credentials and optionally push them            |

For the full flag reference, see [docs/cli-reference.md](docs/cli-reference.md).


## TypeScript SDK

`@amika/sdk` is a typed wrapper around the REST API for Node.js callers.

```bash
npm install @amika/sdk
```

```ts
import { AmikaClient } from "@amika/sdk";

const amika = new AmikaClient({
  baseUrl: "https://app.amika.dev",
  accessToken: process.env.AMIKA_API_KEY!,
});

// Create a sandbox (returns immediately with state "initializing")
const sb = await amika.createSandbox({
  name: "dev-box",
  repoUrl: "https://github.com/gofixpoint/example-repo",
  preset: "coder",
});

// Wait until it's ready (polls every 3s)
await amika.waitForSandbox(sb.name);

// Send a prompt to an agent
const resp = await amika.agentSend(sb.name, {
  message: "Refactor the auth module",
  agent: "claude",
});
console.log(resp.result);

// Tear down
await amika.deleteSandbox(sb.name);
```

Point `baseUrl` at the hosted API (`https://app.amika.dev`) or a local `amika-server`. See [sdk/typescript/README.md](sdk/typescript/README.md) for the full method list, configuration options, and error handling.

## amikalog

`amikalog` is a separate, independently-versioned CLI that captures Claude Code and Codex hook activity — along with the git state of each hook's working directory — as append-only events under the amika state directory.

### Install

Install the latest release binary with the install script, passing `--component amikalog`:

```bash
curl -fsSL https://raw.githubusercontent.com/gofixpoint/amika/main/install.sh | sh -s -- --component amikalog
```

This downloads the release binary, verifies its checksum, and installs `amikalog` to `/usr/local/bin` (override with `AMIKA_INSTALL_DIR`). Pin a specific version with `--install-version`:

```bash
curl -fsSL https://raw.githubusercontent.com/gofixpoint/amika/main/install.sh | sh -s -- --component amikalog --install-version 0.1.0
```

<details>
<summary>Build from source instead</summary>

Requires Go 1.21+. Build outputs land in `dist/`:

```bash
git clone https://github.com/gofixpoint/amika.git && cd amika
make build-amikalog
```

When built from source, invoke the binary as `./dist/amikalog`.

</details>

### Capture agent activity

Install the Claude Code and Codex hooks once — this is what makes `amikalog` start recording:

```bash
amikalog start
```

From then on, agent and git activity is captured as append-only events under the amika state directory. Run `amikalog stop` to remove the hooks.

Optionally sync captured events with your org's storage (requires `AMIKA_API_KEY`):

```bash
amikalog beta:push          # upload not-yet-pushed events
amikalog beta:fetch <dir>   # download the org bucket into <dir>
```

See [docs/amikalog.md](docs/amikalog.md) for the full command reference, event storage layout, and event schema.

## Status

Amika is in **beta**. APIs and CLI flags may change. If something breaks or you have ideas, [open an issue](https://github.com/gofixpoint/amika/issues) — feedback shapes what we build next.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup and guidelines.

## License

[Apache 2.0](LICENSE)

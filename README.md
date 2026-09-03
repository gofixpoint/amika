<p align="center">
  <h1 align="center">amika</h1>
  <p align="center"><strong>Multiplayer cloud workstations for coding agents and humans</strong></p>
  <p align="center">Provision VMs on any cloud or computer, load them with your favorite agent(s), and then remote control the agents from any chat surface, app, or API.</p>
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
  <a href="https://app.amika.dev/signup">Sign up</a> |
  <a href="https://docs.amika.dev/">Docs</a> |
  <a href="https://discord.gg/xDXk4KjGWg">Discord</a> |
  <a href="https://github.com/gofixpoint/amika/blob/main/docs/AXIOMS.md">Axioms</a>
</p>

---

## Multiplayer cloud workstations for coding agents and humans

Amika lets you **provision VMs on any cloud or computer, load them with your favorite agent(s), and then remote control the agents from any chat surface or app.**

- **Run anywhere.** Use Kubernetes, E2B, or your own computer.
- **Bring any agent.** Use Codex, Claude, OpenCode, Pi, or your own agent with existing subscriptions and API keys.
- **Control from anywhere.** Use chat apps, the web UI, API, CLI, SSH, or your editor.

## What can an Amika sandbox do?

On a sandbox, you can

- **run 1 or more agents** simultaneously
- **expose the HTTPS URLs** of the apps your agent is working on
- let sandboxes and their agents **communicate with each other**
- **programmatically control** the sandbox and its agents
- **connect** to the sandbox from tools like the **Codex app, Cursor, and cmux**

Each sandbox can be short-lived or persistent, depending on whether you want it to disappear when your PR is done, or whether you want to keep it around more permanently.

Amika **automatically wires your Git repos and agent configs and credentials** into each sandbox.

## What can you use Amika for?

Since Amika schedules cloud VMs and then gives you networking, agent messaging, and chat UIs, you can use it in many ways. Some examples:

- create **multiplayer cloud devboxes** for engineers that are pre-configured with your tech stack
- build **managed cloud agents** that you **control via API** to automate work in the background
- **plug into your GitHub CI** to not only run unit tests, but **auto-fix failures*
- make **custom agents for non-technical teammates** to chat with on the web
- **talk with agents** from other **tools like Slack and Linear**

You can use Amika for anything where you need cloud VMs and control over the VMs, their agents, and their file contents or git repos.

## Getting started

To get started with Amika's cloud product:

1. Sign up at https://app.amika.dev/signup and follow onboarding.

2. Download the CLI

   ```
   curl -fsSL https://raw.githubusercontent.com/gofixpoint/amika/main/install.sh | sh
   ```

3. Login, and sync your Claude and/or Codex credentials

   ```
   amika auth login
   amika secret codex push --type oauth --name "Codex Subscription"
   amika secret claude push --type oauth --name "Claude Subscription"
   ```


Now, you can either (a) create a sandbox and then connect to it however you choose, or (b) directly start an agent chat session, which will provision its own sandbox behind the scenes. Both can be done from the https://app.amika.dev/, and also from the CLI.

### creating a sandbox

If you want to create a sandbox and then chat with it from Codex, Cursor, OpenCode, SSH, etc., you can create a sandbox without first making an agent session.

Assuming you connected GitHub during web onboarding:

```
# make sure you uploaded an SSH key
amika secret ssh-keygen

cd path/to/git/repo/you/want/to/work/on
amika sandbox create --name my-first-sandbox
amika sandbox ssh my-first-sandbox
```

This spins up a sandbox, pre-loaded with your Git repo and agent credentials.


### creating an agent chat session

```
cd path/to/git/repo/you/want/to/work/on
amika send --agent codex "What does this repo do?"
```

This will spin up a sandbox in the background and send the message to a Codex agent on the sandbox.

### Self-hosting

If you want to self-host, read the [self-hosting guide](./docs/self-hosting.md).

## Configuration

Usually, **each sandbox boots from a repo**, which specifies the config for the sandbox (VM size, git repos loaded, agent skills, MCP servers, config files loaded). You define **config-as-code inside a repo's `.amika/config.toml`**, but you can also configure settings in the web UI or adhoc per sandbox. See [more docs](https://docs.amika.dev/guides/configuration) on how configuration works.

## Amika principles

Our goal is to make cloud agents and VMs feel like you're just using your desktop, but with extra super-powers:

- **multiplayer**: multiple humans and agents can share the same sandbox and chat sessions
- **programmatic control + human-in-the-loop**: you must be able to toggle between (a) programmatic or agentic control of the sandboxes and agents, and (b) human-in-the-loop UIs
- **multi-surface**: talk to agents from (a) work tools like Slack and Linear, (b) the web UI, API, CLI + SSH, and (c) your preferred editors and ADEs like Cursor and the Codex app
- **run any harness, any model, any ADE**: everybody has their favorite harness, models, and agent development environments; an Amika sandbox doesn't restrict you to just one
- **run on any computer or cloud**: You should be able to slice any computer up into sandbox workstations — the desktop in your closet, a sandbox on E2B, a node in your Kubernetes cluster
- **config-as-code**: your sandbox configuration and agent workflows are just code in a git repo; you can pick which config to use per sandbox, with per-user config customization

See more of [our axioms](https://github.com/gofixpoint/amika/blob/main/docs/AXIOMS.md) about the type of workstation agents need, and what a new "operating system" for agents should look like.

## How Amika compares to other products

Amika is kind of like an "operating system" for AI agents. We have a few important parts:

- a VM networking and agent messaging layer
- a VM scheduling layer
- the control plane that manages these
- the UIs and interfaces to work with the agents and sandboxes

Compared to **agents and agent development environments (ADEs)** like Claude, Codex, OpenCode, Conductor, cmux: **we are not an agent or a harness**. We are **an environment and cloud workstation** for humans and agents. You can connect to an Amika sandbox and its agents using these other tools. In some ways, you can think of us like an "operating system" for AI agents.

Compared to **sandbox cloud providers** like E2B, Daytona, Modal, Sail Research: we are **a networked runtime and "operating system"** on top of **any cloud or computer**. We schedule VM workstations on any compute provider, tune it to be a great agent workstation, and turn the sandbox workstation into an agent mesh network to connect the sandboxes and agents together.

## What's open source and what's closed source

### Open source

- `amika`: CLI to interact with Amika
- `amikad`: daemon that runs inside each VM or machine; manages sandbox setup, network connectivity, and communication with the `amika-gateway` and the e2e-encrypted `amika-relay`
- `sandbox-image`: Sandbox VM snapshots + images. Defines the sandbox environment for the agents ([docs](./sandbox-image/README.md))
- `amika-sdks`: Typescript SDK to interact with Amika

### Closed source

- `amika-control-plane`: control plane that schedules sandboxes and stores references to all sandboxes
- `amika-ui`: web UI for interacting with Amika agents and sandboxes
- `amika-relay`: handles fully e2e encrypted...
  - messages to agents
  - exec commands to sandboxes
  - network and SSH access

### What will be open sourced soon

- `amika-gateway`: gateway inside your cloud that receives signed or encrypted commands, decrypts them, runs auth checks, and sends them to the right sandbox or agent
  - `sandbox-provisioner`: the adapter layer that converts gateway sandbox commands to the right format per provider (ie E2B, K8S, Modal, Daytona, etc.)


## Other tools and links

Other tools:

- [`amikalog`](./docs/amikalog.md): capture your Claude Code and Codex sessions, alongside the git repo changes
- [`amikalyze`](./docs/labs/amikalyze.md): experimental guardrails that control which files coding agents can modify
- [`akfs`](./docs/labs/akfs.md): experimental tooling for treating file contents as structured data that humans and AI agents can work with
- [`js/sandbox`](./js/sandbox/src/providers/README.md): Typescript package for plugging sandbox providers into Amika

Links:

- [amika.dev](https://www.amika.dev/): cloud service
- [docs.amika.dev](https://docs.amika.dev/): docs

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup and guidelines.

## License

[Apache 2.0](LICENSE)

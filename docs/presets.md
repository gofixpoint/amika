# Preset Images

Amika includes preset Docker images that come pre-configured with common
development tools and coding agent CLIs. Presets are selected with
`sandbox create --preset`.

## Available Presets

### `coder` (default)

The default preset, used when no `--preset` flag is provided.

**Image name:** `amika/coder:latest`

**Base:** Ubuntu 24.04

**Included tools:**

- git, curl, zsh, build-essential
- Python 3 + pip
- Node.js 22, pnpm
- TypeScript, tsx
- Claude Code (`@anthropic-ai/claude-code`)
- Codex (`@openai/codex`)
- OpenCode (`opencode-ai`)
- Pi (`@earendil-works/pi-coding-agent`)
- amika, amikalog, and amikad CLIs

### `coder-plus-docker`

A variant of `coder` that also includes Docker-in-Docker support.

**Image name:** `amika/coder-plus-docker:latest`

**Base:** Ubuntu 24.04

**Included tools:**

- Everything in `coder`
- Docker Engine and Buildx

## Usage

```bash
# Explicit preset selection
amika sandbox create --preset coder
amika sandbox create --preset coder-plus-docker

# Default behavior (uses coder preset automatically)
amika sandbox create
```

## Auto-Build

Preset images are built automatically on first use. When you run a command that
needs a preset image and it does not exist locally, Amika builds it from the
embedded shared bundle and tags it. This one-time build may take a few minutes.

To force a rebuild (e.g. after updating Amika), remove the existing image:

```bash
docker rmi amika/coder:latest
```

The next command that uses the preset will rebuild it.

## Setup Scripts

The local Docker runtime runs `/usr/local/etc/amikad/setup/setup.sh` before the
sandbox command. By default this is a no-op script. When creating a sandbox,
use `--setup-script` to inject your own setup logic:

```bash
amika sandbox create --setup-script ./install-deps.sh
```

See [sandbox-configuration.md](sandbox-configuration.md) for details.

## Container Directory Layout

Every container has parallel `amikad` and `amika` directories. Preset images
provision the persistent ones:

- `/usr/lib/amikad` and `/usr/lib/amika`
- `/usr/local/etc/amikad` and `/usr/local/etc/amika`
- `/var/lib/amikad` and `/var/lib/amika`
- `/var/log/amikad` and `/var/log/amika`

The `/run` and `/tmp` pairs are created at container start instead, because both
filesystems are wiped on every boot and no image can carry them:

- `/run/amikad` and `/run/amika`
- `/tmp/amikad` and `/tmp/amika`

Use `amikad` paths for Amika-managed daemon and system files. Use `amika` paths for user-managed Amika content.

The user-supplied setup hook remains at `/usr/local/etc/amikad/setup/setup.sh`.

## Reserved Ports

Preset images reserve container ports 60899–60999 for Amika internal services
(e.g. OpenCode web on 60998, Pi Web on 60996, amikad daemon on 60999). See
[sandbox-configuration.md](sandbox-configuration.md#reserved-ports) for the
full allocation table.

## Image Name Prefix

Set the `AMIKA_PRESET_IMAGE_PREFIX` environment variable to override the default image name prefix. For example:

```bash
export AMIKA_PRESET_IMAGE_PREFIX=myregistry/amika
```

This produces image names like `myregistry/amika-coder:latest` instead of `amika/coder:latest`.

## Agent credentials

Rigs get their coding-agent credentials from the Amika control plane. See
[secrets.md](secrets.md) and the `--agent-credential` flags on
`amika sandbox create`.

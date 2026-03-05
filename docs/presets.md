# Preset Images

Amika includes preset Docker images that come pre-configured with common development tools and coding agent CLIs. Presets are used by both `sandbox create` and `materialize`.

## Available Presets

### `coder` (default)

The default preset, used when no `--image` or `--preset` flag is provided.

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

### `claude`

A lighter preset focused on Claude Code only.

**Image name:** `amika/claude:latest`

**Base:** Ubuntu 24.04

**Included tools:**

- git, curl, zsh, build-essential
- Python 3 + pip
- Node.js 22, pnpm
- TypeScript, tsx
- Claude Code (`@anthropic-ai/claude-code`)

## Usage

```bash
# Explicit preset selection
amika sandbox create --preset coder
amika sandbox create --preset claude

# Default behavior (uses coder preset automatically)
amika sandbox create

# Materialize with a preset
amika materialize --preset claude --cmd "claude --help" --destdir /tmp/out
```

The `--preset` and `--image` flags are mutually exclusive. Use `--image` to specify a custom Docker image instead.

## Auto-Build

Preset images are built automatically on first use. When you run a command that needs a preset image and it doesn't exist locally, Amika builds it from the bundled Dockerfile and tags it. This one-time build may take a few minutes.

To force a rebuild (e.g. after updating Amika), remove the existing image:

```bash
docker rmi amika/coder:latest
```

The next command that uses the preset will rebuild it.

## Setup Scripts

Both presets include an ENTRYPOINT that runs `/opt/setup.sh` before the main command. By default this is a no-op script. When creating a sandbox, use `--setup-script` to inject your own setup logic:

```bash
amika sandbox create --setup-script ./install-deps.sh
```

See [sandbox-configuration.md](sandbox-configuration.md) for details.

## Image Name Prefix

Set the `AMIKA_PRESET_IMAGE_PREFIX` environment variable to override the default image name prefix. For example:

```bash
export AMIKA_PRESET_IMAGE_PREFIX=myregistry/amika
```

This produces image names like `myregistry/amika-coder:latest` instead of `amika/coder:latest`.

## Agent Credential Auto-Mounting

When creating a sandbox or running materialize, Amika automatically discovers and mounts credential files for supported coding agents. These files are mounted as `rwcopy` so the container gets a snapshot and cannot modify the originals on the host.

The following credential files are auto-mounted when they exist:

**Claude Code:**

- `~/.claude.json.api`
- `~/.claude.json`
- `~/.claude/.credentials.json`
- `~/.claude-oauth-credentials.json`

**Codex:**

- `~/.codex/auth.json`

**OpenCode:**

- `~/.local/share/opencode/auth.json`
- `~/.local/state/opencode/model.json`

Inside the container, these files appear at the same relative paths under `/home/amika/`. This means coding agents running inside sandboxes can authenticate without manual configuration.

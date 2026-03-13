# Sandbox Configuration

## Setup Scripts

The `--setup-script` flag lets you mount a local script into the container at `/usr/local/etc/amikad/setup/setup.sh`. The script runs automatically when the container starts, before the main command (CMD).

### Usage

```bash
# sandbox create
amika sandbox create --setup-script ./my-setup.sh

# materialize
amika materialize --setup-script ./my-setup.sh --cmd "echo done" --destdir /tmp/out
```

### Writing a setup script

Your script just needs to do its setup work and exit 0. You do **not** need to chain into the next command — the container's ENTRYPOINT handles that automatically.

```bash
#!/bin/bash
set -e

apt-get update && apt-get install -y ripgrep
pip install numpy
```

The script is mounted read-only, so it cannot be modified from inside the container.

### How it works

Preset images (coder, claude) bake a no-op `/usr/local/etc/amikad/setup/setup.sh` into the image and declare an ENTRYPOINT that runs it before execing into CMD:

```dockerfile
RUN mkdir -p /usr/local/etc/amikad/setup \
    && printf '#!/bin/bash\nexit 0\n' > /usr/local/etc/amikad/setup/setup.sh \
    && chmod +x /usr/local/etc/amikad/setup/setup.sh
ENTRYPOINT ["/bin/bash", "-c", "/usr/local/etc/amikad/setup/setup.sh && exec \"$@\"", "--"]
```

When you pass `--setup-script`, your script is bind-mounted over the no-op, so the ENTRYPOINT runs your script instead.

### Notes

- The script must be executable (`chmod +x`).
- If the script exits with a non-zero status, the container's main command will not run.
- Preset images are cached locally. If you have an existing preset image from before the setup script feature was added, you need to rebuild your images by removing the old image first: `docker rmi amika/coder:latest`.

## Git Repository Cloning

The `--git` CLI flag and the `GitRepo` HTTP API field clone a remote or local git repository into a Docker volume that is mounted at `/home/amika/workspace/<repo-name>` inside the sandbox.

### CLI (`--git`)

`--git` clones the local repository containing the current working directory (or a given path). It always sources from a local git repo on the host.

```bash
# Clone the current repo (clean clone)
amika sandbox create --git

# Include untracked/uncommitted files
amika sandbox create --git --no-clean

# Clone the repo containing a specific path
amika sandbox create --git ./src
```

### HTTP API (`GitRepo`)

The `GitRepo` field on `POST /v1/sandboxes` accepts a URL pointing to any remote or local git repository. Supported URL schemes:

| Scheme     | Example                                               |
| ---------- | ----------------------------------------------------- |
| `https://` | `https://github.com/octocat/Hello-World.git`          |
| `http://`  | `http://git.example.com/repo.git`                     |
| `ssh://`   | `ssh://git@github.com/org/proj.git`                   |
| `file:///` | `file:///home/user/local-repo.git` (must be absolute) |
| SCP-style  | `git@github.com:org/proj.git`                         |

```bash
curl -X POST http://localhost:8080/v1/sandboxes \
  -H 'Content-Type: application/json' \
  -d '{"GitRepo": "https://github.com/octocat/Hello-World.git"}'
```

The repository is cloned on the host, copied into a named Docker volume, and mounted read-write at `/home/amika/workspace/<repo-name>`. The volume is tracked by `amika volume list`. If the clone fails, no sandbox is created.

### Notes

- `file://` URLs must use three slashes (`file:///absolute/path`). Relative paths are rejected.
- The volume name is derived from the sandbox name and repo name, e.g. `amika-git-teal-tokyo-Hello-World-<timestamp>`.
- Deleting the sandbox does not automatically delete the git volume; use `amika volume delete` when you no longer need it.

## Per-repo configuration: `.amika/config.toml`

When you use `--git`, Amika looks for a `.amika/config.toml` file at the root of the repository and applies it automatically. This lets you commit sandbox configuration alongside your code so every collaborator gets the same environment without passing extra flags.

### File location

```
<repo-root>/
  .amika/
    config.toml
```

### Supported fields

```toml
[lifecycle]
# Path to an executable that is mounted into the container at /usr/local/etc/amikad/setup/setup.sh.
# Relative paths are resolved from the repository root.
setup_script = "scripts/setup.sh"
```

#### `[lifecycle].setup_script`

Works exactly like `--setup-script`: the script is bind-mounted read-only at `/usr/local/etc/amikad/setup/setup.sh` and the container's ENTRYPOINT runs it before the main command.

**Path resolution:** if the value is a relative path it is resolved from the repository root (the directory containing `.git`). Absolute paths are used as-is.

### Interaction with `--setup-script`

`--setup-script` always takes priority. When that flag is passed explicitly, `.amika/config.toml` is not consulted for the setup script.

| Flags passed                                  | Source used                       |
| --------------------------------------------- | --------------------------------- |
| `--git` only                                  | `.amika/config.toml` (if present) |
| `--git --setup-script /path/script.sh`        | `--setup-script` flag             |
| `--setup-script /path/script.sh` (no `--git`) | `--setup-script` flag             |

### Example

Given this repository layout:

```
my-project/
  .amika/
    config.toml       # setup_script = "scripts/setup.sh"
  scripts/
    setup.sh          # must be executable (chmod +x)
```

Running `amika sandbox create --git` from anywhere inside `my-project` will automatically mount `scripts/setup.sh` to `/usr/local/etc/amikad/setup/setup.sh` in the container.

## Agent Credential Auto-Mounting

When creating a sandbox or running materialize, Amika automatically discovers credential files for supported coding agents on the host and mounts them into the container as `rwcopy` snapshots. This means agents running inside containers can authenticate without manual configuration.

The container receives copies of the files — the originals on the host are never modified.

### Files mounted

**Claude Code:** `~/.claude.json.api`, `~/.claude.json`, `~/.claude/.credentials.json`, `~/.claude-oauth-credentials.json`

**Codex:** `~/.codex/auth.json`

**OpenCode:** `~/.local/share/opencode/auth.json`, `~/.local/state/opencode/model.json`

Only files that exist on the host are mounted. Inside the container, they appear at the same relative paths under `/home/amika/`.

This behavior is automatic and requires no flags. See [presets.md](presets.md) for more details on preset images.

## Reserved Ports

Amika reserves container ports **60899–60999** (101 ports) for internal
services that run inside sandboxes. User workloads and setup scripts should
avoid binding to ports in this range.

| Port        | Service                          | Status   |
| ----------- | -------------------------------- | -------- |
| 60999       | amikad daemon                    | Reserved |
| 60998       | OpenCode web UI                  | Active   |
| 60899–60997 | *(unassigned, reserved for use)* | Reserved |

The OpenCode web server starts automatically on port 60998 when OpenCode is
installed in the container and `AMIKA_OPENCODE_WEB` is not set to `0`. The
port number is written to `/run/amikad/opencode-web.port` at startup.

# Sandbox Configuration

## Setup Scripts

The `--setup-script` flag uploads a local script for the hosted rig to run at
`/usr/local/etc/amikad/setup/setup.sh`. The script runs during rig
initialization, before the agent starts.

### Usage

```bash
amika sandbox create --setup-script ./my-setup.sh
```

### Writing a setup script

Your script just needs to do its setup work and exit 0. You do **not** need to
chain into the next command. Amika continues the rig lifecycle automatically.

```bash
#!/bin/bash
set -e

apt-get update && apt-get install -y ripgrep
pip install numpy
```

### How it works

The CLI reads the file and sends its contents to the Amika API. During
provisioning, Amika installs the uploaded script at
`/usr/local/etc/amikad/setup/setup.sh` and runs the shared lifecycle hooks:

```text
pre-setup.sh -> setup.sh -> post-setup.sh -> requested command
```

When neither setup flag is present, hosted Amika resolves the setup script from
the rig's UI or stored settings, then from the selected branch's
`.amika/config.toml`. The image's no-op script is the final fallback. Pass
`--no-setup` to force that no-op. `--setup-script` and `--no-setup` are
mutually exclusive.

### Notes

- The local file does not need executable permissions; Amika makes the uploaded
  script executable in the rig.
- Setup scripts run with the working directory set to the agent's working directory (`$AMIKA_AGENT_CWD`).
- If the script exits with a non-zero status, rig initialization fails and the
  agent does not start.

## Git Repository Cloning

### CLI (`--git`)

By default, `amika sandbox create` walks up from the current working directory,
finds the first git repository, and sends its origin URL to hosted Amika. The
control plane clones the selected remote branch. Local uncommitted changes are
not copied.

Pass `--git <path>` to select a different local repository and use its origin,
`--git <url>` to send a remote URL directly, or `--no-git` to create a rig
without a repository.

```bash
# Clone the remote branch for the current repository
amika sandbox create

# Use the origin of a repository at a specific local path
amika sandbox create --git ./src

# Clone a remote git URL (HTTPS or SSH)
amika sandbox create --git https://github.com/octocat/Hello-World.git

# Skip auto-detection and create a sandbox without any repo
amika sandbox create --no-git
```

### Self-hosted HTTP API (`GitRepo`)

The self-hosted `amika-server` API has different local behavior. Its `GitRepo`
field on `POST /v1/sandboxes` accepts a URL pointing to a remote repository or
to a repository accessible from the server host. Supported URL schemes:

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

The self-hosted server clones the repository on its host, copies it into a
named Docker volume, and mounts that volume read-write at
`/home/amika/workspace/<repo-name>`. If the clone fails, no sandbox is created.

### Notes

- `file://` URLs are supported by the self-hosted API, not by hosted cloning.
  They must use three slashes (`file:///absolute/path`), and relative paths are
  rejected.
- The self-hosted volume name is derived from the sandbox name and repository
  name, for example `amika-git-teal-tokyo-Hello-World-<timestamp>`.

## Per-repo configuration: `.amika/config.toml`

Hosted Amika reads `.amika/config.toml` from the repository branch selected for
the rig and applies it during provisioning. The CLI does not read an
uncommitted local copy of this file. Commit and push configuration changes so
the control plane can see them in the remote repository.

This lets you keep shared rig configuration alongside the code while allowing
CLI flags and UI settings to override those defaults. See the hosted
[configuration guide](https://docs.amika.dev/guides/configuration) for the full
schema.

### File location

```
<repo-root>/
  .amika/
    config.toml
```

### Supported fields

```toml
[lifecycle]
# Path to a setup script in the repository.
setup_script = "scripts/setup.sh"

[env]
# Plain environment variables
MY_VAR = "my-value"
# Secret references — resolved from the remote secrets store
MY_SECRET = { secret = "my-secret-name" }
```

#### `[lifecycle].setup_script`

Amika reads the script from the selected repository branch, installs it at
`/usr/local/etc/amikad/setup/setup.sh`, and runs it during rig initialization.

Paths are relative to the repository root. For a script outside the repository,
pass its local path with `--setup-script` so the CLI uploads its contents.

### Interaction with `--setup-script`

`--setup-script` always takes priority over the repository setting.

| Flags passed                                              | Source used                                      |
| --------------------------------------------------------- | ------------------------------------------------ |
| Repo backed, no `--setup-script`                          | Selected branch's `.amika/config.toml`, if any   |
| Repo backed plus `--setup-script /path/script.sh`         | Uploaded local file                              |
| `--setup-script /path/script.sh` with `--no-git`          | Uploaded local file                              |

### Example

Given this repository layout:

```
my-project/
  .amika/
    config.toml       # setup_script = "scripts/setup.sh"
  scripts/
    setup.sh
```

After these files are committed and pushed, running `amika sandbox create`
from anywhere inside `my-project` auto-detects the repository. Hosted Amika
reads the selected branch's config and runs `scripts/setup.sh` while
provisioning the rig.

### `[env]` — Environment variables

The `[env]` section declares environment variables that are set inside the sandbox. Values can be plain strings or references to secrets stored in the remote Amika secrets store.

```toml
[env]
# Plain string — set as-is
DATABASE_HOST = "localhost"

# Secret reference — resolved from the remote secrets store at sandbox creation
ANTHROPIC_API_KEY = { secret = "my-anthropic-key" }
```

Secrets referenced with `{ secret = "name" }` must be pushed to the remote store before sandbox creation, either via `amika secret push` or through the web UI. See [secrets.md](secrets.md) for details.

### Branch selection

`--branch` checks out a branch if it exists, or creates it if it doesn't. `--new-branch` always creates a new branch and errors if it already exists. When both are used, `--branch` is resolved first and `--new-branch` branches off it.

The **base branch** — used when creating a branch that doesn't exist — is your current checked-out branch when the repo source is a local path (auto-detect or `--git <path>`), or the repo's default branch when the source is a URL.

| Flags | Result |
| --- | --- |
| _(neither)_ | Base branch |
| `--branch foo` | `foo` (checked out or created from base) |
| `--new-branch bar` | `bar` (created from base) |
| `--branch foo --new-branch bar` | `bar` (created from `foo`) |

Hosted Amika reads `.amika/config.toml` from whatever branch the rig ends up
on. Local uncommitted changes are not visible during provisioning.

## Agent credentials

Rigs get their coding-agent credentials from the Amika control plane, not from
your host. Pin one explicitly at creation time with `--agent-credential`,
`--agent-credential-type`, or `--no-agent-credential`, and manage the stored
credentials with `amika secret`. See [secrets.md](secrets.md).

Earlier versions discovered credential files on the host and mounted them into
the local Docker container. That went away with the `--local` mode.

## Reserved Ports

Amika reserves container ports **60899–60999** (101 ports) for internal
services that run inside sandboxes. User workloads and setup scripts should
avoid binding to ports in this range.

| Port        | Service                          | Status   |
| ----------- | -------------------------------- | -------- |
| 60999       | amikad daemon                    | Reserved |
| 60998       | OpenCode web UI                  | Active   |
| 60997       | amikad managed sshd (loopback)   | Active   |
| 60996       | Pi Web UI                        | Active   |
| 60899–60995 | _(unassigned, reserved for use)_ | Reserved |

The OpenCode web server starts automatically on port 60998 when OpenCode is
installed in the container and `AMIKA_OPENCODE_WEB` is not set to `0`. The
port number is written to `/run/amikad/opencode-web.port` at startup.

[Pi Web](https://github.com/agegr/pi-web) serves a browser UI for the `pi`
agent on port 60996, over the same `~/.pi/agent` state the CLI uses. Pi's own
CLI has no web server, so this is the equivalent of `opencode web`.

It is opt-in (`AMIKA_PI_WEB=1`) and refuses to start without two things:
`AMIKA_PI_WEB_PASSWORD`, enforced as HTTP basic auth under the fixed username
`pi`, and `AMIKA_PI_WEB_ALLOWED_HOSTS`, the public hostname the sandbox is
reached through. Pi Web answers `403 Untrusted request` to any other Host
header and accepts no wildcard, so an endpoint without it could serve nothing.
The port number is written to `/run/amikad/pi-web.port` at startup.

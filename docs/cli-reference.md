# CLI Reference

Complete reference for all `amika` commands, flags, and environment variables.

## `amika sandbox`

Manage Docker-backed persistent sandboxes with bind mounts and named volumes.

### Global sandbox flags

These persistent flags apply to all `sandbox` subcommands (`create`, `list`, `connect`, `stop`, `start`, `delete`, `ssh`, `code`, `agent-send`):

| Flag       | Default | Description                      |
| ---------- | ------- | -------------------------------- |
| `--local`  | `false` | Only operate on local sandboxes  |
| `--remote` | `false` | Only operate on remote sandboxes |

When none of these flags are set, the default behavior depends on login state: if you are logged in, both local and remote sandboxes are shown; otherwise only local.

`--local` and `--remote` are mutually exclusive.

### `amika sandbox create`

Create a new sandbox.

```bash
# Minimal — auto-generates a name, uses the coder preset image
amika sandbox create --yes

# Named sandbox with mounts
amika sandbox create --name dev-sandbox \
  --mount ./src:/workspace/src:ro \
  --mount ./out:/workspace/out

# Auto-detect the git repo containing the current working directory
# (this is the default behavior when no --git/--no-git flag is passed)
amika sandbox create --name dev-sandbox

# Mount git repo with untracked/uncommitted files included (local sandboxes only)
amika sandbox create --name dev-sandbox --no-clean

# Mount git repo at a specific path
amika sandbox create --name dev-sandbox --git ./src

# Mount a remote git repo by URL (HTTPS or SSH)
amika sandbox create --name dev-sandbox --git https://github.com/octocat/Hello-World.git

# Skip git auto-detection and create a bare sandbox
amika sandbox create --name dev-sandbox --no-git

# Use the claude preset image
amika sandbox create --name claude-box --preset claude

# Use a custom Docker image
amika sandbox create --name custom-box --image myimage:latest

# Attach an existing tracked volume
amika sandbox create --name dev-sandbox-2 \
  --volume amika-rwcopy-dev-sandbox-workspace-out-123:/workspace/out:rw

# Set environment variables
amika sandbox create --name dev-sandbox --env MY_KEY=my_value

# Create and immediately connect
amika sandbox create --name dev-sandbox --connect

# Run a setup script on container start
amika sandbox create --name dev-sandbox --setup-script ./install-deps.sh

# Publish a container port to the host
amika sandbox create --name dev-sandbox --port 8080:8080

# Publish a port bound to all interfaces
amika sandbox create --name dev-sandbox --port 3000:3000 --port-host-ip 0.0.0.0

# Clone a specific git branch
amika sandbox create --name dev-sandbox --branch develop

# Create a new branch from your current branch
amika sandbox create --new-branch feature-x

# Create a new branch starting from a specific existing branch
amika sandbox create --branch main --new-branch bugfix-1

# Inject remote secrets (remote sandboxes only)
amika sandbox create --name dev-sandbox --remote \
  --secret env:ANTHROPIC_API_KEY=my-claude-key
```

#### Flags

| Flag                    | Default              | Description                                                                                                                          |
| ----------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `--name <name>`         | auto-generated       | Name for the sandbox. If omitted, a random `{color}-{city}` name is generated (e.g. `teal-tokyo`)                                    |
| `--provider <name>`     | `docker`             | Sandbox provider (only `docker` is currently supported)                                                                              |
| `--image <image>`       | `amika/coder:latest` | Docker image to use (mutually exclusive with `--preset`)                                                                             |
| `--preset <name>`       |                      | Use a preset environment, e.g. `coder` or `claude` (mutually exclusive with `--image`). See [presets.md](presets.md)                 |
| `--mount <spec>`        |                      | Mount a host path (`source:target[:mode]`, mode defaults to `rwcopy`). Repeatable                                                    |
| `--volume <spec>`       |                      | Mount an existing named volume (`name:target[:mode]`, mode defaults to `rw`). Repeatable                                             |
| `--git <path\|url>`     |                      | Mount the git repo at `path` or cloned from a URL (HTTPS, SSH) to `/home/amika/workspace/{repo}`. If omitted, auto-detects the repo containing the current working directory. Clean clone by default |
| `--no-git`              | `false`              | Skip git auto-detection; create a sandbox without mounting any repo                                                                  |
| `--no-clean`            | `false`              | With a local-path git source, include untracked/uncommitted files instead of a clean clone. Local sandboxes only                     |
| `--env <KEY=VALUE>`     |                      | Set environment variable. Repeatable                                                                                                 |
| `--port <spec>`         |                      | Publish a container port (`hostPort:containerPort[/protocol]`, protocol defaults to `tcp`). Repeatable                               |
| `--port-host-ip <ip>`   | `127.0.0.1`          | Host IP address to bind all published ports to. Use `0.0.0.0` to bind to all interfaces                                              |
| `--yes`                 | `false`              | Skip mount confirmation prompt                                                                                                       |
| `--connect`             | `false`              | Connect to the sandbox shell immediately after creation                                                                              |
| `--setup-script <path>` |                      | Mount a local script to `/usr/local/etc/amikad/setup/setup.sh` (read-only). See [sandbox-configuration.md](sandbox-configuration.md) |
| `--branch <name>`       |                      | Check out this branch, or create it if it doesn't exist. Requires a git repo (auto-detected or via `--git`)                          |
| `--new-branch <name>`  |                      | Create a new branch (errors if it already exists). Starts from `--branch` if set, otherwise from the base branch. Requires a git repo (auto-detected or via `--git`)  |
| `--secret <spec>`       |                      | Inject a remote secret (`env:FOO=SECRET_NAME` or `env:SECRET_NAME`). Repeatable. Requires `--remote`. See [secrets.md](secrets.md)   |

#### Mount modes

| Mode     | Behavior                                                                                                                                 |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `ro`     | Read-only bind mount from host                                                                                                           |
| `rw`     | Read-write bind mount from host (writes sync back to host)                                                                               |
| `rwcopy` | Read-write snapshot in a Docker volume (default for `--mount`). Host files are copied in; writes stay in the volume and do not sync back |

### `amika sandbox list`

List all tracked sandboxes.

```bash
amika sandbox list
```

Output columns: `NAME`, `STATE`, `LOCATION`, `PROVIDER`, `IMAGE`, `BRANCH`, `REPO`, `CREATED BY`, `PORTS`, `CREATED`.

The `REPO` column lists the repositories mounted into the sandbox workspace (`/home/amika/workspace/<repo>`). For remote sandboxes it shows the repository name parsed from the sandbox's `repo_url`.

The `CREATED BY` column shows the human who created a remote sandbox (name, falling back to email). It is always `-` for local sandboxes and for remote sandboxes whose creator the server could not resolve (deleted user, API-key principal, or `noop` auth mode).

### `amika sandbox connect`

Connect to a running sandbox container with an interactive shell.

```bash
# Connect with default shell (zsh)
amika sandbox connect dev-sandbox

# Connect with a different shell
amika sandbox connect dev-sandbox --shell bash
```

| Flag              | Default | Description                           |
| ----------------- | ------- | ------------------------------------- |
| `--shell <shell>` | `zsh`   | Shell to run in the sandbox container |

The shell starts in `/home/amika`.

### `amika sandbox delete`

Delete one or more sandboxes and their backing containers. Aliases: `rm`, `remove`.

```bash
# Delete a sandbox (prompts about exclusive volumes)
amika sandbox delete dev-sandbox

# Delete multiple sandboxes
amika sandbox delete sandbox-1 sandbox-2

# Also delete associated unreferenced volumes
amika sandbox delete dev-sandbox --delete-volumes

# Keep all volumes without prompting
amika sandbox delete dev-sandbox --keep-volumes
```

| Flag               | Default | Description                                                                           |
| ------------------ | ------- | ------------------------------------------------------------------------------------- |
| `--delete-volumes` | `false` | Delete associated volumes that are no longer referenced by other sandboxes            |
| `--keep-volumes`   | `false` | Keep associated volumes without prompting, even if this sandbox is the only reference |

When neither flag is set and the sandbox is the sole reference for a volume, you will be prompted to decide.

### `amika sandbox stop`

Stop one or more running sandboxes without removing them.

```bash
amika sandbox stop dev-sandbox
amika sandbox stop sandbox-1 sandbox-2
```

### `amika sandbox start`

Start (resume) one or more stopped sandboxes.

```bash
amika sandbox start dev-sandbox
amika sandbox start sandbox-1 sandbox-2
```

### `amika sandbox ssh`

SSH into a remote sandbox, or revoke SSH access. Optionally pass a command to execute instead of opening an interactive session.

```bash
# Interactive SSH session
amika sandbox ssh my-sandbox

# Run a command on the remote sandbox
amika sandbox ssh my-sandbox -- ls -la

# Force pseudo-terminal allocation (for interactive programs)
amika sandbox ssh -t my-sandbox -- top

# Revoke SSH access
amika sandbox ssh my-sandbox --revoke
```

| Flag        | Default | Description                                                                 |
| ----------- | ------- | --------------------------------------------------------------------------- |
| `-t`        | `false` | Force pseudo-terminal allocation (useful for interactive remote programs)    |
| `--revoke`  | `false` | Revoke SSH access for the sandbox                                           |

### `amika sandbox code`

Open a remote sandbox in an editor via SSH.

```bash
amika sandbox code my-sandbox
amika sandbox code my-sandbox --editor=cursor
```

| Flag               | Default  | Description                      |
| ------------------ | -------- | -------------------------------- |
| `--editor <name>`  | `cursor` | Editor to open (currently only `cursor` is supported) |

### `amika sandbox agent-send`

Send a prompt to an AI agent CLI running inside a sandbox container. The message can be provided as a positional argument or piped via stdin. By default the command waits for the agent to finish and streams the response.

```bash
# Send a message to Claude in a sandbox
amika sandbox agent-send my-sandbox "Add unit tests for the auth module"

# Pipe a message via stdin
echo "Fix the failing tests" | amika sandbox agent-send my-sandbox

# Send without waiting for a response
amika sandbox agent-send my-sandbox "Refactor the API layer" --no-wait

# Use a different agent CLI
amika sandbox agent-send my-sandbox "Review this code" --agent codex
```

| Flag                  | Default            | Description                                                  |
| --------------------- | ------------------ | ------------------------------------------------------------ |
| `--no-wait`           | `false`            | Send the instruction and return immediately without waiting  |
| `--workdir <path>`    | `$AMIKA_AGENT_CWD` | Working directory inside the container                       |
| `--agent <name>`      | `claude`           | Agent CLI to use                                             |

---

## `amika scp`

Copy files between the local machine, sandboxes, and SSH hosts. This is a thin wrapper around the system `scp` binary: every argument is forwarded to `scp` unchanged, so all the usual `scp` flags (`-r`, `-p`, `-C`, `-v`, ...) work.

```bash
amika scp <source> ... <target>
```

Sandbox names are resolved wherever they appear, so a single command can copy between two sandboxes, or between a sandbox and an SSH host. Sources and targets may take any of these forms:

| Form                              | Meaning                                                                        |
| --------------------------------- | ------------------------------------------------------------------------------ |
| `PATH`                            | A local path                                                                   |
| `NAME[:PATH]`                     | A path in sandbox `NAME` (scp-style); a relative `PATH` is under the sandbox home (`/home/amika`), an absolute `PATH` is used verbatim |
| `sbox://NAME[/PATH]`              | A path in sandbox `NAME` (URI form); `PATH` is absolute and `~` is the home directory. A `/` in `NAME` must be percent-encoded as `%2F` |
| `scp://[user@]host[:port][/path]` | A path on an arbitrary SSH host                                                |

A bare `host:path` **always** names a sandbox; to reach an arbitrary SSH host, use an `scp://` URI. When every remote is a sandbox, the connection uses `StrictHostKeyChecking=accept-new`; when an external host or a jump host is involved, no host-key option is injected (scp applies `-o` options to every hop), so your normal SSH config governs. A non-default sandbox port is carried inline as a self-porting `scp://host:port//path` operand, so sandboxes and hosts on differing ports can be copied together. A password in an `scp://user:password@host` URI is rejected, since `scp` cannot use one non-interactively.

A copy between the local machine and a sandbox is **streamed over an SSH exec channel** rather than run through `scp`. Daytona's `linux-vm` SSH gateway does not deliver the client's channel-EOF to a non-interactive remote, so `scp` (and `sftp`) complete the transfer but then hang forever waiting to tear the session down. The stream instead uses remote commands that exit on their own — `cat` to download, `head -c <size>` (bounded so it never waits for EOF) to upload, with `tar` for directories (`-r`). External `scp://` copies and local-only copies keep the real `scp` binary, which has no such teardown problem. Sandbox↔sandbox and sandbox↔external copies are not yet supported over the stream (copy via the local machine in two steps).

```bash
# Upload a file into the sandbox home
amika scp ./local.txt my-sandbox:local.txt

# Recursively download an absolute directory from the sandbox
amika scp -r my-sandbox:/srv/out ./out

# Sandbox URI form, relative to the home directory
amika scp ./a.txt sbox://my-sandbox/~/a.txt

# Copy from a sandbox to another SSH host
amika scp my-sandbox:/data.csv scp://user@host:22/tmp/data.csv
```

| Flag       | Default | Description                                            |
| ---------- | ------- | ------------------------------------------------------ |
| `--print`  | `false` | Print the resolved `scp` command instead of running it |

---

## `amika volume`

Manage tracked Docker volumes used by sandboxes.

### `amika volume list`

List all tracked volumes (both directory-backed and file-backed).

```bash
amika volume list
```

Output columns: `NAME`, `TYPE`, `CREATED`, `IN_USE`, `SANDBOXES`, `SOURCE`.

### `amika volume delete`

Delete one or more tracked volumes. Aliases: `rm`, `remove`.

```bash
# Delete an unused volume
amika volume delete my-volume

# Force delete even if referenced by sandboxes
amika volume delete my-volume --force
```

| Flag      | Default | Description                                         |
| --------- | ------- | --------------------------------------------------- |
| `--force` | `false` | Delete volume even if still referenced by sandboxes |

---

## `amika auth`

Authentication and credential commands.

### `amika auth login`

Log in to Amika via a device authorization flow. Opens a browser for you to authorize the CLI.

```bash
amika auth login
```

See [auth.md](auth.md) for details on the login flow and session storage.

### `amika auth status`

Show current authentication status.

```bash
amika auth status
```

Prints the logged-in email and organization, or "Not logged in" if no session exists.

### `amika auth logout`

Log out of Amika and remove the saved session.

```bash
amika auth logout
```

### `amika auth extract`

Discover locally stored credentials from multiple sources and print shell environment assignments.

```bash
# Print assignments
amika auth extract

# Export for current shell session
eval "$(amika auth extract --export)"

# Use an alternate home directory
amika auth extract --homedir /tmp/test-home

# Skip OAuth credential sources
amika auth extract --no-oauth
```

| Flag               | Default | Description                                           |
| ------------------ | ------- | ----------------------------------------------------- |
| `--export`         | `false` | Prefix each line with `export`                        |
| `--homedir <path>` |         | Override home directory used for credential discovery |
| `--no-oauth`       | `false` | Skip OAuth credential sources                         |

See [auth.md](auth.md) for details on supported credential sources and priority.

---

## `amika secret`

Manage secrets in the remote Amika secrets store. See [secrets.md](secrets.md) for details on the env file format and usage.

### `amika secret extract`

Discover locally stored credentials and optionally push them to the remote store.

```bash
amika secret extract
amika secret extract --push
amika secret extract --push --only=ANTHROPIC_API_KEY,OPENAI_API_KEY
```

| Flag               | Default | Description                                                                               |
| ------------------ | ------- | ----------------------------------------------------------------------------------------- |
| `--push`           | `false` | Push discovered secrets to the remote store after confirmation                            |
| `--only <keys>`    |         | Comma-separated list of secret names to include (e.g. `ANTHROPIC_API_KEY,OPENAI_API_KEY`) |
| `--scope <scope>`  | `user`  | Secret scope: `user` (private) or `org` (visible to org members)                          |
| `--homedir <path>` |         | Override home directory used for credential discovery                                     |
| `--no-oauth`       | `false` | Skip OAuth credential sources                                                             |

### `amika secret push`

Push secrets to the remote store from inline arguments, environment variables, or a `.env` file.

```bash
amika secret push ANTHROPIC_API_KEY=sk-ant-xxx
amika secret push --from-env=ANTHROPIC_API_KEY,OPENAI_API_KEY
amika secret push --from-file=.env
amika secret push --from-file=.env CUSTOM_KEY=val --from-env=ANTHROPIC_API_KEY
```

| Flag                 | Default | Description                                                                        |
| -------------------- | ------- | ---------------------------------------------------------------------------------- |
| `--from-env <keys>`  |         | Comma-separated list of environment variable names to read and push                |
| `--from-file <path>` |         | Path to a `.env` file containing `KEY=VALUE` secrets. See [secrets.md](secrets.md) |
| `--scope <scope>`    | `user`  | Secret scope: `user` (private) or `org` (visible to org members)                   |

When multiple sources are used, positional arguments override `--from-file` values, and `--from-env` overrides both.

### `amika secret claude`

Manage Claude Code credentials for sandbox authentication. Credentials pushed here can be injected into sandboxes at creation time.

#### `amika secret claude push`

Push Claude Code credentials (API key or OAuth token) to the remote Amika secrets store. Scans your system for Claude credentials and lets you choose which one to push. On macOS, the keychain is also checked.

```bash
# Interactive — discover and select credentials
amika secret claude push

# Push with a custom label
amika secret claude push --name "Claude OAuth (Work Laptop)"

# Push from a credentials file
amika secret claude push --from-file ~/.claude/.credentials.json

# Push a credential value directly
amika secret claude push --value '{"claudeAiOauth":{...}}'

# Auto-resolve by type (reads ANTHROPIC_API_KEY env var for api_key)
amika secret claude push --type api_key
```

| Flag                 | Default | Description                                                     |
| -------------------- | ------- | --------------------------------------------------------------- |
| `--name <label>`     |         | Human-readable label for the credential (prompted if omitted)   |
| `--value <string>`   |         | Credential value (skips interactive discovery)                  |
| `--from-file <path>` |         | Path to a credentials file (skips interactive discovery)        |
| `--type <type>`      | `oauth` | Credential type: `oauth` or `api_key`                           |

`--value` and `--from-file` are mutually exclusive.

#### `amika secret claude list`

List pushed Claude credentials.

```bash
amika secret claude list
```

Output columns: `ID`, `NAME`, `TYPE`.

#### `amika secret claude delete`

Delete a Claude credential by ID.

```bash
amika secret claude delete <id>
```

---

## `amika materialize`

Run a script or command in an ephemeral Docker container and copy outputs to a destination directory.

The container runs with working directory `/home/amika/workspace`. Exactly one of `--script` or `--cmd` must be specified.

```bash
# Run a script, copy results to a destination
amika materialize --script ./pull-data.sh --destdir ./output

# Run an inline command
amika materialize --cmd "curl -s https://api.example.com/data > result.json" --destdir ./output

# Specify which container directory to copy from
amika materialize --script ./transform.sh --outdir /app/results --destdir ./output

# Run interactively (e.g. launch Claude Code inside the container)
amika materialize -i --cmd claude --mount $(pwd):/workspace --env ANTHROPIC_API_KEY=...

# Use a preset image
amika materialize --preset claude --cmd "claude --help" --destdir /tmp/out

# Run a setup script before the main command
amika materialize --setup-script ./install-deps.sh --cmd "echo done" --destdir /tmp/out
```

### Flags

| Flag                    | Default              | Description                                                                                                                          |
| ----------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `--script <path>`       |                      | Path to the script to execute (mutually exclusive with `--cmd`)                                                                      |
| `--cmd <string>`        |                      | Bash command string to execute (mutually exclusive with `--script`)                                                                  |
| `--outdir <path>`       | workdir              | Container directory to copy from. Absolute paths are used as-is; relative paths resolve from workdir                                 |
| `--destdir <path>`      | **(required)**       | Host directory where output files are copied                                                                                         |
| `--image <image>`       | `amika/coder:latest` | Docker image to use (mutually exclusive with `--preset`)                                                                             |
| `--preset <name>`       |                      | Use a preset environment, e.g. `coder` or `claude` (mutually exclusive with `--image`). See [presets.md](presets.md)                 |
| `--mount <spec>`        |                      | Mount a host directory (`source:target[:mode]`, mode defaults to `rw`). Repeatable                                                   |
| `--env <KEY=VALUE>`     |                      | Set environment variable in the container. Repeatable                                                                                |
| `-i`, `--interactive`   | `false`              | Run interactively with TTY (for programs like `claude`)                                                                              |
| `--setup-script <path>` |                      | Mount a local script to `/usr/local/etc/amikad/setup/setup.sh` (read-only). See [sandbox-configuration.md](sandbox-configuration.md) |

Script arguments can be passed after `--`:

```bash
amika materialize --script ./gen.sh --destdir /tmp/dest -- arg1 arg2
```

---

## `amika-server`

HTTP server that exposes the Amika API as a REST service. This is a separate binary (`dist/amika-server`).

```bash
# Start with default address (:8080)
amika-server

# Specify a custom listen address
amika-server -addr :9090

# Or use the PORT environment variable
PORT=9090 amika-server
```

| Flag / Env          | Default | Description                                               |
| ------------------- | ------- | --------------------------------------------------------- |
| `-addr <host:port>` | `:8080` | HTTP listen address                                       |
| `PORT` (env)        |         | Override listen address (mutually exclusive with `-addr`) |

The server provides OpenAPI documentation at `/openapi.json` and `/docs`.

### API Endpoints

| Method   | Path                   | Description                 |
| -------- | ---------------------- | --------------------------- |
| `GET`    | `/v1/health`           | Health check                |
| `GET`    | `/v1/sandboxes`        | List sandboxes              |
| `POST`   | `/v1/sandboxes`        | Create a sandbox            |
| `DELETE` | `/v1/sandboxes/{name}` | Delete a sandbox            |
| `GET`    | `/v1/volumes`          | List volumes                |
| `DELETE` | `/v1/volumes/{name}`   | Delete a volume             |
| `POST`   | `/v1/auth/extract`     | Extract credentials         |
| `POST`   | `/v1/materialize`      | Run a materialize operation |

### `POST /v1/sandboxes` — Port Publishing

The `Ports` field accepts an array of port binding objects. It is the HTTP API equivalent of the `--port` and `--port-host-ip` CLI flags.

```json
{
  "Ports": [
    {
      "HostIP": "127.0.0.1",
      "HostPort": 8080,
      "ContainerPort": 80,
      "Protocol": "tcp"
    },
    { "HostPort": 5432, "ContainerPort": 5432, "Protocol": "tcp" }
  ]
}
```

| Field           | Required | Default     | Description                                                      |
| --------------- | -------- | ----------- | ---------------------------------------------------------------- |
| `HostPort`      | yes      |             | Port on the host (1–65535)                                       |
| `ContainerPort` | yes      |             | Port inside the container (1–65535)                              |
| `Protocol`      | no       | `"tcp"`     | `"tcp"` or `"udp"`                                               |
| `HostIP`        | no       | `127.0.0.1` | Host IP to bind the port. Use `"0.0.0.0"` to bind all interfaces |

Duplicate bindings (same `HostIP:HostPort/Protocol`) are rejected with a 400 error.

### API-Only Fields

The HTTP API accepts some fields that are not available as CLI flags:

- **`SetupScriptText`** (on `POST /v1/sandboxes`): Inline setup script content as a string. Amika writes it to a temporary file and mounts it as `/usr/local/etc/amikad/setup/setup.sh`. Mutually exclusive with `SetupScript` (file path).
- **`GitRepo`** (on `POST /v1/sandboxes`): URL of a git repository to clone into the sandbox. The repo is cloned on the host, copied into a Docker volume, and mounted at `/home/amika/workspace/<repo-name>`. Supported schemes: `https://`, `http://`, `ssh://`, `file:///` (absolute paths only), and SCP-style (`git@host:path`). See [sandbox-configuration.md](sandbox-configuration.md) for details.

---

## Environment Variables

| Variable                    | Description                                                                                                                                                        |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `AMIKA_STATE_DIRECTORY`     | Override the default state directory (`~/.local/state/amika`). All state files are stored here when set                                                            |
| `AMIKA_PRESET_IMAGE_PREFIX` | Override the Docker image name prefix for presets. E.g. setting to `myregistry/amika` produces `myregistry/amika-coder:latest`                                     |
| `AMIKA_API_URL`             | Override the remote API base URL (default: `https://app.amika.dev`). Used by sandbox commands when operating on remote sandboxes                                   |
| `AMIKA_WORKOS_CLIENT_ID`    | Override the default WorkOS client ID for `amika auth login`. If you change `AMIKA_API_URL`, you likely need to update this too                                    |
| `AMIKA_RUN_EXPENSIVE_TESTS` | Set to `1` to enable expensive Docker rebuild integration tests during `go test`                                                                                   |
| `PORT`                      | Override listen address for `amika-server`. Accepts a plain port (`8080` becomes `:8080`) or full address (`127.0.0.1:8080`). Mutually exclusive with `-addr` flag |

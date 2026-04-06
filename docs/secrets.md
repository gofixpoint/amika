# Secrets

Secrets are credentials stored in the remote Amika secrets store. They can be injected into sandboxes at creation time using the `--secret` flag on `sandbox create`.

Each secret has a **name** (e.g. `ANTHROPIC_API_KEY`), a **value**, and a **scope**:

- **user** (default): Private to your account.
- **org**: Visible to all members of your organization.

## Extracting local credentials

`amika secret extract` discovers credentials stored locally by various AI coding tools (Claude, Codex, OpenCode, Amp) and displays them.

```bash
# Show discovered credentials
amika secret extract

# Discover and push to the remote store
amika secret extract --push

# Only push specific keys
amika secret extract --push --only=ANTHROPIC_API_KEY,OPENAI_API_KEY
```

See [auth.md](auth.md) for details on supported credential sources.

## Pushing secrets

`amika secret push` pushes secrets to the remote store. Secrets can come from three sources:

```bash
# Inline KEY=VALUE arguments
amika secret push ANTHROPIC_API_KEY=sk-ant-xxx

# Read from environment variables
amika secret push --from-env=ANTHROPIC_API_KEY,OPENAI_API_KEY

# Load from a .env file
amika secret push --from-file=.env
```

Sources can be combined. When the same key appears in multiple sources, later sources override earlier ones: `--from-file` (base) < positional args < `--from-env`.

Before pushing, the command displays all secrets with masked values and asks for confirmation.

If a secret already exists remotely with the same scope, it is updated. If it exists with a different scope, the command errors and suggests using `--scope` to match.

## Env file format

The `--from-file` flag reads a `.env` file using Docker-style parsing. The format is intentionally simple to avoid accidentally mangling secret values.

### Rules

- **Blank lines** are skipped.
- **Comment lines** starting with `#` (with optional leading whitespace) are skipped.
- **Key-value lines** must contain `=`. The key is everything before the first `=` (trimmed of whitespace). The value is everything after the first `=`, taken **verbatim**.
- **Lines without `=`** that are not blank or comments produce an error with the line number.

### What is NOT supported

- **Quote stripping**: `KEY="value"` sets the value to `"value"` (with quotes). If you don't want quotes in the value, don't put them in the file.
- **Inline comments**: `KEY=value # comment` sets the value to `value # comment`. The `#` is part of the value.
- **`export` prefix**: `export KEY=value` is treated as key `export KEY`, not `KEY`.
- **Variable substitution**: `${OTHER_VAR}` is taken literally.
- **Multiline values**: Each line is parsed independently.

### Example

```bash
# API credentials
ANTHROPIC_API_KEY=sk-ant-a1b2c3d4e5f6
OPENAI_API_KEY=sk-proj-abcdef123456

# Database
DATABASE_URL=postgres://user:pass#123@db.example.com:5432/mydb

# Empty value is allowed
OPTIONAL_FLAG=
```

## Claude Code credentials

`amika secret claude` manages Claude Code credentials separately from general secrets. These credentials (OAuth tokens or API keys) can be injected into sandboxes at creation time so Claude Code is pre-authenticated without manual login.

### Workflow

1. **Push credentials** from your local machine:

```bash
# Interactive discovery (scans Claude config files and macOS keychain)
amika secret claude push

# Or specify directly
amika secret claude push --type api_key --value sk-ant-xxx
```

2. **List stored credentials:**

```bash
amika secret claude list
```

3. **Inject when creating a sandbox** — credentials can be selected via the web UI or referenced via the `--secret` flag on `amika sandbox create`.

4. **Delete a credential:**

```bash
amika secret claude delete <id>
```

See [cli-reference.md](cli-reference.md) for the full flag reference.

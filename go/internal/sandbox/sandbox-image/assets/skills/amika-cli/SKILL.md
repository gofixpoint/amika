---
name: amika-cli
description: "Drive the `amika` CLI to create, inspect, and operate Amika sandboxes and agent chat sessions non-interactively. Use when a task involves `amika sandbox`, `amika send`, `amika auth`, `amika secret`, `amika service`, `amika snapshot`, or `amika scp`, including discovering and debugging services from inside an Amika sandbox."
---

# Using the `amika` CLI

Use `amika` to operate hosted Amika sandboxes and agent chat sessions without
hanging on prompts or interactive sessions. Hosted sandboxes are the default
target. Run `amika <command> --help` before relying on a flag in a reference
because the installed binary is authoritative.

Read only the reference relevant to the task:

- [Sandbox lifecycle, agents, auth, and secrets](references/sandbox-operations.md)
- [Services, repository config, and snapshots](references/services-config-snapshots.md)
- [SSH and file transfer](references/connectivity.md)
- [Structured output and non-interactive behavior](references/non-interactive.md)

## Inside an Amika sandbox

When `$AMIKA_SANDBOX_NAME` is set, it means you are running inside a sandbox,
and it has that sandbox's name. Otherwise, you are running outside a sandbox.

For any task involving a service, URL, port, preview, or local server, inspect
the sandbox's live services first:

```bash
amika service list --sandbox-name "$AMIKA_SANDBOX_NAME" -o json
```

Find the referenced service in that result and use its provisioned `url` and
`ports`. The live service record is authoritative for how to reach the service.
A service whose URL is `-` still exists; it may not have a public URL yet.

Only if the command succeeds and the referenced service is absent should you
inspect the repository's `.amika/config.toml`. Its `[services.<name>]` entry
declares the expected container port and URL scheme, but it does not prove that
the service was provisioned or reveal its current public URL.

If service listing fails, diagnose the CLI or authentication error. Do not
treat a failed lookup as evidence that the service is absent and skip directly
to the config file.

## Safe automation

Follow these rules unless the user explicitly wants an interactive session:

1. Prefer `-o json` or `-o json-pretty` when the command supports it.
2. Supply required confirmation flags up front.
3. Do not run `sandbox connect`, `sandbox code`, or bare `sandbox ssh` in a
   tool call. They require a controllable terminal.
4. Use `amika sandbox ssh <name> <command>` for non-interactive remote work.
5. Use `amika send` to send messages to an agent that either creates a new
   sandbox or lives inside an existing sandbox.
6. Check structured results for per-item errors. Do not rely only on the process
   exit code.

See [non-interactive behavior](references/non-interactive.md) for output shapes,
confirmation flags, and commands that reject JSON output.

## Task routing

| Need | Start with |
|---|---|
| Identify the current sandbox | `$AMIKA_SANDBOX_NAME` |
| Find a service URL or port inside a sandbox | `amika service list --sandbox-name "$AMIKA_SANDBOX_NAME" -o json` |
| Create, list, start, stop, or delete sandboxes | `amika sandbox --help` |
| Run a coding agent | `amika send --help` |
| Run a command remotely | `amika sandbox ssh <name> <command>` |
| Copy files | `amika scp --help` |
| Manage service exposure | `amika service --help` |
| Capture a base environment | `amika snapshot --help` |
| Fork from a snapshot | `amika sandbox create --snapshot <name>` |
| Authenticate in a headless environment | Set `AMIKA_API_KEY` |

## Critical facts

- Sandbox creation auto-detects the current git repository and makes a clean
  clone. Uncommitted work is not copied.
- `snapshot list -o json` returns `{"items": [...]}`; most list commands return
  a bare array.
- `--secret env:KEY=NAME` refers to a stored secret name, not a literal value.
- `amika send` can report an agent failure through `is_error`; inspect
  the result even when the request completed.
- `.amika/config.toml` is the reviewable source for how a repository configures
  a sandbox. It is the default, but can be overridden, so it's not a substitute
  for checking a running sandbox's live state.

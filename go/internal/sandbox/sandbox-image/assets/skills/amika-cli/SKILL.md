---
name: amika-cli
description: "Drive the `amika` CLI to create, inspect, and operate Amika rigs and agent chat sessions non-interactively. Use when a task involves `amika rig`, `amika send`, `amika auth`, `amika secret`, `amika service`, `amika snapshot`, or `amika scp`, including discovering and debugging services from inside an Amika rig."
---

# Using the `amika` CLI

Use `amika` to operate hosted Amika rigs and agent chat sessions without
hanging on prompts or interactive sessions. Hosted rigs are the default
target. Run `amika <command> --help` before relying on a flag in a reference
because the installed binary is authoritative.

Read only the reference relevant to the task:

- [Rig lifecycle, agents, auth, and secrets](references/rig-operations.md)
- [Services, repository config, and snapshots](references/services-config-snapshots.md)
- [SSH and file transfer](references/connectivity.md)
- [Structured output and non-interactive behavior](references/non-interactive.md)

## Inside an Amika rig

When `$AMIKA_RIG_NAME` is set, it means you are running inside a rig,
and it has that rig's name. Otherwise, you are running outside a rig.

For any task involving a service, URL, port, preview, or local server, inspect
the rig's live services first:

```bash
amika service list --rig-name "$AMIKA_RIG_NAME" -o json
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
3. Do not run `rig connect`, `rig code`, or bare `rig ssh` in a
   tool call. They require a controllable terminal.
4. Use `amika rig ssh <name> <command>` for non-interactive remote work.
5. Use `amika send` to send messages to an agent that either creates a new
   rig or lives inside an existing rig.
6. Check structured results for per-item errors. Do not rely only on the process
   exit code.

See [non-interactive behavior](references/non-interactive.md) for output shapes,
confirmation flags, and commands that reject JSON output.

## Task routing

| Need                                       | Start with                                                                 |
| ------------------------------------------ | -------------------------------------------------------------------------- |
| Identify the current rig                   | `$AMIKA_RIG_NAME`                                                         |
| Find a service URL or port inside a rig    | `amika service list --rig-name "$AMIKA_RIG_NAME" -o json`                |
| Create, list, start, stop, or delete rigs | `amika rig --help`                                                        |
| Run a coding agent                         | `amika send --help`                                                       |
| Run a command remotely                     | `amika rig ssh <name> <command>`                                          |
| Copy files                                 | `amika scp --help`                                                        |
| Manage service exposure                    | `amika service --help`                                                    |
| Capture a base environment                 | `amika snapshot --help`                                                   |
| Fork from a snapshot                       | `amika rig create --snapshot <name>`                                      |
| Authenticate in a headless environment     | Set `AMIKA_API_KEY`                                                       |

## Critical facts

- Rig creation auto-detects the current git repository and makes a clean
  clone. Uncommitted work is not copied.
- `snapshot list -o json` returns `{"items": [...]}`; most list commands return
  a bare array.
- `--secret env:KEY=NAME` refers to a stored secret name, not a literal value.
- `amika send` can report an agent failure through `is_error`; inspect
  the result even when the request completed.
- `.amika/config.toml` is the reviewable source for how a repository configures
  a rig. It is the default, but can be overridden, so it's not a substitute
  for checking a running rig's live state.

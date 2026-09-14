# Structured output and non-interactive behavior

## JSON output

Use `-o json` for scripts and `-o json-pretty` for inspection. JSON mode
suppresses progress; subprocess output may go to stderr, leaving stdout as JSON.

```bash
name=$(amika sandbox create --no-git -o json | jq -r .name)
amika sandbox list -o json | jq -r '.[].name'
```

Most list commands return a bare array (`[]` when empty). `snapshot list`
returns `{"items": [...]}`. Batch mutations return an array of item results;
inspect each item's `status` and `error`.

## Prompts

JSON mode never prompts. Pass the bypass flag when required:

| Command | Required flag |
|---|---|
| `sandbox create` with local mounts | `--yes` |
| `sandbox delete` | `--force` |
| `snapshot create` | `--no-interactive`, plus `--mode` and `--name` |
| `snapshot delete` | `--force` / `-f` |
| `service delete` | `--force` / `-f` |
| `secret ssh-key delete` | `--force` / `-f` |

`secret push` and `secret extract --push` have no bypass flag and prompt on
stdin. If the operation is intended, pipe the confirmation:

```bash
printf 'y\n' | amika secret push KEY=value
```

## Commands that are not JSON operations

Do not pass `-o json` to commands that open a shell, editor, browser, or masked
credential prompt:

- `sandbox connect`, `sandbox code`, and `sandbox create --connect`
- bare `sandbox ssh`
- `auth login` without `--api-key-file`
- `secret extract` and `secret push`

`sandbox ssh` and `scp` delegate to system tools and reject Amika's `--output`
flag. With `sandbox ssh`, arguments after the sandbox name belong to the remote
command. With `scp`, short `-o` is the system `scp` option.

Avoid launching an interactive command in a plain tool call. It will block on a
TTY. An interactive command is appropriate only in a terminal or tmux pane that
you can control.

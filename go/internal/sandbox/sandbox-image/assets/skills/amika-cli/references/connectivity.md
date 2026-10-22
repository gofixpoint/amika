# SSH, editors, and file transfer

## Run remote commands

Create or import the SSH identity once per machine:

```bash
amika secret ssh-keygen
```

Then run a command without opening an interactive shell:

```bash
amika rig ssh my-rig ls -la
amika rig ssh -t my-rig top
amika rig ssh -N -L 6789:localhost:3010 my-rig
```

`rig ssh` uses Amika's direct WebSocket transport and forwards SSH options.
Use bare `amika rig ssh my-rig` only in a controllable terminal.

## Open a rig in an editor or app

`amika rig open` (alias `rig code`) hands a rig's SSH host to a local
editor or app. `--app` (alias `--editor`) picks the target: `cursor`
(default), `vscode`, `claude`, `codex`, `paseo`, or `herdr`. `herdr` runs
`herdr machine add <ssh-host> --label <rig>`.

```bash
amika rig open my-rig --app=herdr
```

These launch or configure apps on the user's machine and may prompt, so run
them only when the user asks, in a controllable terminal.

## Copy files

`amika scp` forwards arguments to system `scp`, including `-r`, `-p`, `-C`,
`-v`, and `-o Option=value`.

```bash
amika scp ./local.txt my-rig:local.txt
amika scp -r my-rig:/srv/out ./out
amika scp my-rig:/data.csv scp://user@host:22/tmp/data.csv
amika scp --print ./a.txt my-rig:a.txt
```

Path forms:

| Form                            | Meaning                                               |
| ------------------------------- | ----------------------------------------------------- |
| `PATH`                          | Local path                                            |
| `NAME[:PATH]`                   | Rig path; relative paths start under `/home/amika`    |
| `rig://NAME[/PATH]`             | Rig URI; the path is absolute and `~` means home (`sbox://` also works) |
| `scp://[user@]host[:port][/path]` | Arbitrary SSH host                                  |

A bare `host:path` always names an Amika rig. Use an `scp://` URI for an
arbitrary SSH host. `scp` needs the same SSH identity as `rig ssh`.

# SSH and file transfer

## Run remote commands

Create or import the SSH identity once per machine:

```bash
amika secret ssh-keygen
```

Then run a command without opening an interactive shell:

```bash
amika sandbox ssh my-sandbox ls -la
amika sandbox ssh -t my-sandbox top
amika sandbox ssh -N -L 6789:localhost:3010 my-sandbox
```

`sandbox ssh` uses Amika's direct WebSocket transport and forwards SSH options.
Use bare `amika sandbox ssh my-sandbox` only in a controllable terminal.

## Copy files

`amika scp` forwards arguments to system `scp`, including `-r`, `-p`, `-C`,
`-v`, and `-o Option=value`.

```bash
amika scp ./local.txt my-sandbox:local.txt
amika scp -r my-sandbox:/srv/out ./out
amika scp my-sandbox:/data.csv scp://user@host:22/tmp/data.csv
amika scp --print ./a.txt my-sandbox:a.txt
```

Path forms:

| Form | Meaning |
|---|---|
| `PATH` | Local path |
| `NAME[:PATH]` | Sandbox path; relative paths start under `/home/amika` |
| `sbox://NAME[/PATH]` | Sandbox URI; the path is absolute and `~` means home |
| `scp://[user@]host[:port][/path]` | Arbitrary SSH host |

A bare `host:path` always names an Amika sandbox. Use an `scp://` URI for an
arbitrary SSH host. `scp` needs the same SSH identity as `sandbox ssh`.

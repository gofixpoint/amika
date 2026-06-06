# Amika Labs

Experimental Amika tooling lives under [`go/labs/`](../../go/labs/). Everything
here is a work in progress and carries **no compatibility guarantees** — APIs,
commands, flags, and entire packages may change or disappear at any time. Don't
depend on it from stable code (`go/cmd/amika`, `go/cmd/amika-server`,
`go/pkg/amika`, `go/internal/*`).

The labs subtree mirrors the spirit of
[`golang.org/x/exp`](https://pkg.go.dev/golang.org/x/exp): a place to prototype
against the real building blocks before anything graduates into the supported
surface.

## What's here

| Tool | Description | Docs |
| ---- | ----------- | ---- |
| `akfs` | Experimental Amika filesystem CLI and library | [akfs.md](akfs.md) |

## Building

The labs binaries are built by the default `make build`, and each has a
dedicated target:

```bash
make build-akfs      # builds dist/akfs
```

`bin/akfs` is a wrapper that auto-builds and runs `dist/akfs`.

## Stability and the labs boundary

`go/labs/` is part of the main `github.com/gofixpoint/amika/go` module (rather
than a separate module) so labs code can import the existing `go/internal/*`
packages and `go/pkg/amika`. The "labs" boundary is enforced by convention —
path, this documentation, and package doc comments — not by module separation.

Dependencies pulled in by labs experiments land in the root `go/go.mod`; prune
them when an experiment is removed.

For the in-repo policy and module-boundary rationale, see
[`go/labs/README.md`](../../go/labs/README.md) and
[`go/labs/AGENTS.md`](../../go/labs/AGENTS.md).

## Graduating an experiment

When something here proves out, promote it: move the library into `go/pkg/` (or
a supported `go/internal/*` package), move the binary to `go/cmd/`, and write a
spec under `specs/`. Until then, treat everything here as throwaway.

# Amika Labs

Experimental code lives here. Anything under `go/labs/` is a work in progress
and carries **no compatibility guarantees** — APIs, commands, flags, and entire
packages may change or disappear at any time. Do not depend on it from stable
code (`go/cmd/amika`, `go/cmd/amika-server`, `go/pkg/amika`, `go/internal/*`).

This mirrors the spirit of [`golang.org/x/exp`](https://pkg.go.dev/golang.org/x/exp):
a place to prototype before anything graduates into the supported surface.

## Why it lives inside the main module

`go/labs/` is part of the existing `github.com/gofixpoint/amika/go` module rather
than a separate module. This is deliberate: it lets labs code freely import the
existing `go/internal/*` packages (sandbox, auth, config, …) and `go/pkg/amika`.
A separate module — or a directory outside `go/` — would be blocked from
importing `go/internal/*` by Go's internal-package rule, which would defeat the
purpose of experimenting against the real building blocks.

The "labs" boundary is therefore enforced by convention (path + this README +
package doc comments), not by module separation. Dependencies pulled in by labs
experiments land in the root `go/go.mod`; prune them when an experiment is
removed.

## Layout

```
go/labs/
  README.md          # this file
  cmd/akfs/          # akfs CLI binary (experimental)
  akfs/              # akfs library: github.com/gofixpoint/amika/go/labs/akfs
```

## Building

```bash
make build-akfs      # builds dist/akfs
```

## Graduating an experiment

When something here proves out, promote it: move the library into `go/pkg/` (or
a supported `go/internal/*` package), move the binary to `go/cmd/`, and write a
spec under `specs/`. Until then, treat everything here as throwaway.

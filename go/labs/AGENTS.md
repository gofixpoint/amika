# Labs — agent guidance

Experimental, unstable code with **no compatibility guarantees**. APIs,
commands, and entire packages may change or disappear at any time.

- Lives in the main `github.com/gofixpoint/amika/go` module so it can import
  `go/internal/*` and `go/pkg/amika`.
- Stable code (`go/cmd/amika`, `go/cmd/amika-server`, `go/pkg/amika`,
  `go/internal/*`) must **not** import from `go/labs/`.
- Build the `akfs` CLI with `make build-akfs` (output `dist/akfs`); it is also
  built as part of the default `make build`. `bin/akfs` is a wrapper that
  auto-builds and runs it.

See `go/labs/README.md` for full context and the graduation path.

# Sandbox image — agent guidance

Source of truth for the `coder` and `coder-dind` images. Most of this
directory is generated, so an edit here is only half the change.

- **Never hand-edit generated files.** `generated/*.Dockerfile`,
  `generated/bundle.json`, and everything under
  `go/internal/sandbox/sandbox-image/` are generator output.
- **Run the generator after any change** to `manifest.toml`, `versions.env`,
  `steps/`, `assets/`, or `verify/`, then check it:

  ```bash
  python3 sandbox-image/generate.py
  make test-sandbox-image
  ```

- **Commit the source change and every generated file together.** The
  `go/internal/sandbox/sandbox-image/` mirror duplicates this bundle on
  purpose, so `go install` needs no code-generation step. That duplication is
  intentional; do not "clean it up".
- `python3 sandbox-image/generate.py --check` verifies generated files are
  current without writing them.

## Verification checks

`verify/checks/` is auto-discovered by `find` (executable `*.sh`, sorted), so a
new check needs no registration. Each sets `CHECK_CONTEXTS`:

- `build` — image properties, asserted once at build time.
- `boot` — costs every sandbox start. Only for what cannot be checked earlier.

Prefer `build`. A `build,boot` check pays its cost on every sandbox a customer
starts.

## Paths shared with the control plane

Some paths in this image are claimed by `amika-mono` at provision time, so a
change here can break something no diff in this repo shows. `/usr/local/bin/gh`
is one: the `app_token` gh shim installs there and resolves the real `gh` by
scanning `PATH` for one that is not itself, which works only while the image
installs `gh` elsewhere (`16-gh-shim-path-free.sh` guards this).

See `sandbox-image/README.md` for the full change workflow and local builds.

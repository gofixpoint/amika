# Sandbox image bundle

This directory is the source of truth for the `coder` and `coder-dind`
sandbox images. The manifest declares the image contract, ordered steps,
assets, version pins, and preset membership. Provider publishers and the local
CLI consume generated artifacts rather than implementing provisioning logic of
their own.

## Change workflow

1. Edit `manifest.toml`, `versions.env`, a step under `steps/`, or an asset.
2. Regenerate the committed artifacts:

   ```bash
   python3 sandbox-image/generate.py
   ```

3. Check the bundle and generated output:

   ```bash
   make test-sandbox-image
   ```

   To check only that generated files are current, without writing them:

   ```bash
   python3 sandbox-image/generate.py --check
   ```

4. Commit the source change and every generated file changed by the generator.

Do not edit generated files by hand. Update their manifest inputs and rerun the
generator instead.

## Generated outputs

The generator writes these provider-facing artifacts:

- `generated/coder.Dockerfile`
- `generated/coder-dind.Dockerfile`
- `generated/daytona/{coder,coder-dind}.Dockerfile`
- `generated/e2b/{coder,coder-dind}.Dockerfile`
- `generated/bundle.json`

The top-level Dockerfiles contain the shared preset steps and remain the OCI
build inputs for local Docker and consumers without an explicit provider
variant. Provider directories contain the same preset after filtering its
provider-qualified entries. `bundle.json` contains only shared steps and is the
ordered execution plan consumed by Freestyle's shared-step fallback.

Preset step entries are either a string, which applies to every output, or an
inline table restricted to declared `image.provider_variants`:

```toml
[image]
provider_variants = ["daytona", "e2b"]

[presets.coder]
steps = [
  "runtime-user",
  { step = "daytona-vm-user", providers = ["daytona"] },
  "dotfiles",
]
```

The array position remains the single source of step order. The shared output
omits provider-qualified entries.

The generator also synchronizes `go/internal/sandbox/sandbox-image/`. That is
the Go-embed mirror of the bundle, including generated Dockerfiles, scripts,
assets, and verification files. It is committed because `go install` must build
the CLI without requiring a checkout-specific code-generation step. The Go CLI
extracts this mirror into a temporary Docker build context at runtime.

## Local image builds

Build a generated image directly from this repository:

```bash
./sandbox-image/build.sh coder
./sandbox-image/build.sh coder-dind amika/coder-dind:dev
```

The build context must be the repository root because generated Dockerfiles
refer to files below `sandbox-image/`.

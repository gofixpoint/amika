# Installation

Installing a host has two parts:

1. `install-amika-hostd.sh` installs amika-hostd and the Node.js it runs on.
2. `amika-hostd setup` asks which runtimes the host runs, and installs what
   each one needs (see [Setup](setup-and-secrets.md#setup)).

The script installs nothing that a runtime needs. Keep it that way: put a
new runtime's installs in `src/internal/runtime-install.ts`.

## What each step installs

| Step                                  | Component                          | Location                                           |
| ------------------------------------- | ---------------------------------- | -------------------------------------------------- |
| `install-amika-hostd.sh`              | Launcher                           | `/usr/local/bin/amika-hostd` (`AMIKA_INSTALL_DIR`) |
| `install-amika-hostd.sh`              | Bundle, example config             | `~/.local/share/amika-hostd/` (`AMIKA_HOSTD_HOME`) |
| `install-amika-hostd.sh`              | Private Node.js, if needed         | `<data dir>/node/`                                 |
| `install-amika-hostd.sh`              | smolmachines SDK, `engines.sha256` | `<data dir>/node_modules/`, `<data dir>/`          |
| `install-amika-hostd.sh` (macOS only) | macOS image build files            | `<data dir>/macos-image/`                          |
| `setup`                               | Config                             | `~/.config/amika-hostd/config.toml`                |
| `setup`                               | API key, secret key                | The keychain, or files (`secret_store`)            |
| `setup`, smol                         | smolvm                             | `~/.smolvm/`, `~/.local/bin/smolvm`                |
| `setup`, smol                         | smolmachines engine                | `<data dir>/node_modules/<engine package>/`        |
| `setup`, lume                         | Lume 0.6.1                         | `~/.local/bin/lume`, `~/.local/share/lume/`        |
| `setup`, bare_metal                   | amikad                             | `<data dir>/amikad/<version>/amikad`               |
| `up`, `reload`, lume                  | macOS base VM and template         | `~/.lume/` (Lume's default storage)                |
| `up`                                  | State and logs                     | `~/.local/state/amika-hostd/`                      |
| Rig create, lume                      | Rig VM (an APFS clone)             | `storage_dir` (default `<data dir>/lume/`)         |

`capabilities update --enable <runtime>` installs the same things as setup.
`up` installs them again when they are missing, for example a new amikad or
engine that a new release pins.

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/gofixpoint/amika/main/install-amika-hostd.sh | sh
```

The script asks no questions. It does these steps:

1. Download `amika-hostd_<version>.tar.gz` from the `amika-hostd@v<version>`
   GitHub release, and check it against `checksums.txt`.
2. Copy the bundle, `config.example.toml`, the smolmachines SDK and
   `engines.sha256` into the data directory. On macOS, also copy
   `macos-image/`. Each is replaced whole.
3. Choose the Node.js the launcher runs:
   - Use the system `node` when it is 22 or newer. Its owner keeps it
     patched.
   - Else download Node.js 24.22.1 (`AMIKA_HOSTD_NODE_VERSION`) into
     `node/`, and check it against `SHASUMS256.txt`. A downloaded Node.js
     must be a patched release (`NODE_MIN_VERSIONS`): 22.23.4, 24.22.1 or
     26.12.1. The script replaces an unpatched private `node/`, and refuses
     an unpatched `AMIKA_HOSTD_NODE_VERSION` before it installs anything.
4. Write the launcher, which pins that Node.js.
5. Tell the operator to run `amika-hostd setup`.

Run the script again to update. It chooses the Node.js again, so it moves
the launcher to a system node installed since. `--dry-run` prints the plan.

## Uninstall

`install-amika-hostd.sh --uninstall` does these steps:

1. Find the launcher on `PATH` (or in `AMIKA_INSTALL_DIR`). Read the data
   directory from its `exec` line (`AMIKA_HOSTD_HOME` wins). Show both, and
   ask for confirmation.
2. Ask whether to remove the config and state directories, and whether to
   remove the keychain secrets. `--purge` answers yes to both.
3. Run `amika-hostd uninstall --yes` on the terminal.
4. Delete the launcher and the data directory.
5. Delete the secrets, the config and the state directory, as answered.
6. Print what it never removes: `/etc/amika-hostd` and the host's
   registration in Amika.

`amika-hostd uninstall` (`src/internal/uninstall.ts`) removes what the
runtimes installed:

1. Stop the daemon, as `down` does.
2. Delete the Lume rigs in `machines.json`, then `storage_dir`. `--yes`
   answers this question.
3. Delete the base VM and the templates the Lume presets name, only when
   the operator types `remove macos images`.
4. Delete `~/.smolvm` and its `~/.local/bin` link, only when the operator
   types `remove smolvm`.
5. Name Lume and `$TMPDIR/latest.ipsw`, which it never deletes: other tools
   can use them.

No flag answers a typed-phrase question. Without a terminal, the answer is
no. `--dry-run` prints the plan.

## Release bundle

`pnpm --filter @amika/hostd build` builds the daemon as one ESM file
(`scripts/bundle.mjs`). esbuild inlines every npm dependency, including the
`smol` provider from `@amika/sandbox`, so the bundle runs under plain
`node`. `src/bundle.test.ts` checks this. `@amika/sandbox` is TypeScript
source that hostd resolves bundler-style, so hostd typechecks with
`moduleResolution: "bundler"` and has no `tsc` emit.

The bundle keeps `smolmachines` external, because the SDK finds its native
files beside itself on disk. The daemon does not load it yet: hostd ships it
for the move from `smolvm serve` to the embedded engine.

`scripts/package-release.sh <version> [out-dir]` makes one tarball for every
platform, and writes `checksums.txt`. The tarball holds:

- the bundle, stamped with `v<version>`, the commit and the build time
  (`amika-hostd version` prints them)
- `config.example.toml`
- the `smolmachines` package, at the version `package.json` pins
- `engines.sha256`: each platform's engine archive and its sha256, from
  `npm pack`
- `macos-image/`: `build.sh`, its steps and assets, and
  `sandbox-image/versions.env`

The Release workflow runs the script for an `amika-hostd@v*` tag.

To test the script against a local build, set `AMIKA_RELEASE_URL` to the
build directory, with a temporary `HOME` and `AMIKA_INSTALL_DIR`:

```bash
js/amika-hostd/scripts/package-release.sh 0.1.0 /tmp/hostd-release
HOME=/tmp/hostd-home AMIKA_INSTALL_DIR=/tmp/hostd-bin \
  AMIKA_RELEASE_URL=file:///tmp/hostd-release \
  sh install-amika-hostd.sh
```

`src/installer.test.ts` runs the script that way against a fake release and
Node.js dist (`AMIKA_HOSTD_NODE_DIST_URL`), with fake `node` binaries. It
checks which node the script picks, that the launcher runs it, and that the
script installs nothing for a runtime.

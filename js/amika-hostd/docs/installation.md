# Installation

On a host, install the released daemon with `install-amika-hostd.sh`:

```bash
curl -fsSL https://raw.githubusercontent.com/gofixpoint/amika/main/install-amika-hostd.sh | sh
```

It downloads `amika-hostd_<version>.tar.gz` from the `amika-hostd@v<version>`
GitHub release, verifies it against `checksums.txt`, and installs:

- the bundle and `config.example.toml` into `$XDG_DATA_HOME/amika-hostd`
  (default `~/.local/share/amika-hostd`; override with `AMIKA_HOSTD_HOME`),
  with an `amika-hostd` launcher on `AMIKA_INSTALL_DIR` (default
  `/usr/local/bin`) that pins the node it runs on;
- Node.js: the system `node` if it is 22 or newer, otherwise the official
  Node.js LTS binary (24.21.0, `AMIKA_HOSTD_NODE_VERSION`), verified against
  `SHASUMS256.txt`, into `node/` in that same directory (the system node is
  never touched);
- smolvm, through its official installer, unless `smolvm` is on `PATH` or in
  `~/.smolvm` or `~/.local/bin`. Pin it with `--smolvm-version`
  (`SMOLVM_VERSION`) or skip it with `--skip-smolvm`;
- the machine engine the daemon is moving to: the `smolmachines` SDK
  (smolvm's engine, embedded) the release carries, into `node_modules/` in
  that same directory, plus this platform's engine package
  (`smolmachines-linux-x64-gnu`, `-linux-arm64-gnu` or `-darwin-arm64`:
  native addon, boot helper, hypervisor libraries and guest rootfs, over
  100 MB) downloaded from npm (`AMIKA_HOSTD_NPM_REGISTRY`) and verified
  against the release's `engines.sha256`. Any other platform, or Linux with a
  C library other than glibc 2.34+, fails before anything is downloaded;
- a config: `config.example.toml` copied to the user config path below, with
  `hostname` set to this machine's lowercased `hostname` (left commented when
  it isn't a valid hostname), unless a config already exists there or in
  `/etc`. It is never overwritten, and it holds no secret: `amika-hostd setup`
  keeps the secrets (see [Secret storage](setup-and-secrets.md#secret-storage)).

Its closing steps point the operator at `amika-hostd setup`, then
`amika-hostd up` (which runs setup itself if it was skipped).

On Linux it warns, without failing, when `/dev/kvm` is missing or not
accessible. smolvm copies each disk from a 20 GiB template and shrinks it with
`resize2fs` (from e2fsprogs) when the rig asks for less, so without it a rig
with a smaller disk fails to start. When smolvm cannot find `resize2fs` where
it looks, the installer installs e2fsprogs:

- on macOS with `brew install e2fsprogs`, without asking (no root needed);
- on Linux with `apt-get` (after `apt-get update`), `dnf` or `yum`, quietly
  and noninteractively, as root or through `sudo`. At a terminal it asks
  first, showing the command, and sudo may ask for a password.
  `--install-deps` answers yes instead, and never waits for a password: it
  installs only as root or when `sudo -n` works, so an agent on a
  pseudo-terminal cannot hang at a sudo prompt.

When it cannot (no terminal, not confirmed, sudo needs a password, no known
package manager, a failed install), it warns without failing, giving the
reason and the exact command to run. Before downloading anything it lists
what it will check and install, without asking for confirmation. `--dry-run`
prints the plan, including what it would do about e2fsprogs. Nothing else
needs to run alongside the daemon: `amika-hostd up` starts smolvm itself (see
[smolvm](runtime.md#smolvm)).

`install-amika-hostd.sh --uninstall` reverses the install. It finds the
launcher on `PATH` (or in `AMIKA_INSTALL_DIR` when that is set), reads the
install directory out of the launcher's `exec` line (`AMIKA_HOSTD_HOME` wins
when set), shows both and asks for confirmation; on "no" it tells the user to
set `AMIKA_INSTALL_DIR`. It then runs `amika-hostd down` and deletes the
launcher and the install directory (bundle, `node_modules/`, private `node/`).
It then asks three separate questions: remove the config and state
directories, remove the keychain secrets (`security delete-generic-password`
on macOS, `secret-tool clear` on Linux, plus the file store's `api-key`), and
remove smolvm (`~/.smolvm` and the `~/.local/bin/smolvm` link into it; a smolvm
installed anywhere else is never touched). `--purge` answers the first two
yes without asking, and `--yes` answers every question yes except smolvm's.
smolvm is removed only by typing `remove smolvm` at its prompt: no flag answers for the
user, and without a terminal it stays. Prompts read `/dev/tty`, so `--yes` or
`--purge` is required without one. `/etc/amika-hostd` and the host's Amika
registration are never removed; it prints how to remove each. `--dry-run` previews it.

## Release bundle

The daemon is one ESM file, built by `pnpm --filter @amika/hostd build`
(`scripts/bundle.mjs`, esbuild with every npm dependency inlined, including
the `smol` provider from the workspace's `@amika/sandbox`), so it runs under
plain `node` with no `node_modules`; `src/bundle.test.ts` checks that. The
bundle leaves `smolmachines` external (it finds its native files on disk
beside its own), but the daemon does not load it yet: it is shipped for the
planned move from `smolvm serve` to that embedded engine. `@amika/sandbox` is
TypeScript source resolved bundler-style, so hostd typechecks with
`moduleResolution: "bundler"` and has no `tsc` emit. `scripts/package-release.sh
<version> [out-dir]` wraps the bundle, the example config, the `smolmachines`
package at the exact version `package.json` pins, and `engines.sha256` (each
platform's engine package, fetched with `npm pack`) in one tarball for every
platform, and writes `checksums.txt`. The Release workflow
runs it for an `amika-hostd@v*` tag. To test the installer against a local
build, point `AMIKA_RELEASE_URL` at that directory, with a temporary `HOME`
and `AMIKA_INSTALL_DIR`:

```bash
js/amika-hostd/scripts/package-release.sh 0.1.0 /tmp/hostd-release
HOME=/tmp/hostd-home AMIKA_INSTALL_DIR=/tmp/hostd-bin \
  AMIKA_RELEASE_URL=file:///tmp/hostd-release \
  sh install-amika-hostd.sh
```

# macOS image for Lume rigs

`build.sh` makes the macOS image that Lume rigs clone (spec 028 in
amika-mono). It is apart from the Linux OCI images in `sandbox-image/`, but
uses the same version pins (`sandbox-image/versions.env`).

## Build

amika-hostd builds this image itself when Lume is turned on, with
`amika-hostd setup` or `amika-hostd capabilities update --enable lume`: it
ships this directory and runs the steps below. Build it by hand to work on
the image.

You need an Apple Silicon Mac with Lume, and a base VM from Lume's
unattended install:

```bash
lume create --ipsw <file> --unattended tahoe <base-vm>
macos-image/build.sh <base-vm> <image-vm>
```

The build clones the base VM, runs each file in `steps/` in the clone as
root over SSH, and stops the clone. The clone is the image, in Lume's default
storage. The base VM does not change.

- `AMIKAD_BIN` sets the amikad binary. By default, the build makes it from
  this checkout.
- `STEPS="10-amika-user 60-amikad"` runs only those steps.
- `VERSIONS_ENV` sets the version pins file. By default, the build reads
  this checkout's `sandbox-image/versions.env`.
- `NODE` names a Node.js binary to read Lume's JSON output with. Without it
  the build uses `python3`, which a Mac has only with the Xcode Command Line
  Tools. amika-hostd sets it to its own Node.

A failed build deletes its clone. The build refuses an image name that is
already in Lume, so it never deletes a VM it did not make.

## What the image has

- The `amika` user, with home `/Users/amika` and `sudo` with no password.
- The base VM's bootstrap user `lume` / `lume`, and Remote Login. The rig's
  SSH bootstrap uses that password one time, then turns password login off.
- amikad in `/usr/local/bin`, and its launchd job in `/usr/local/lib/amikad`.
  launchd does not start amikad at boot. Provisioning loads the job after it
  sets new credentials.
- Amika's lifecycle hooks in `/usr/local/lib/amikad` (`run-hook.sh`,
  `pre-setup.sh`, `post-setup.sh`): `/usr/lib` is read-only on macOS.
  `pre-setup.sh` is the Linux hook less Docker, Pi Web, amikalog, and the
  Linux kernel guard. zsh reads Amika's env from `/etc/profile.d`.
- The Xcode Command Line Tools (git, clang, python3), and Homebrew with GNU
  coreutils, sed, findutils, bash 5, and jq.
- Node, npm, and the coding agents, at the pinned versions.

`steps/90-verify.sh` fails the build when one of these is missing, or when
the image has amikad state or SSH keys. A full build takes about 10 minutes
and adds about 9 GB to the base VM's disk.

The rig's PATH comes from `/etc/paths`, with Homebrew first. The provider
loads it before each command, as login shells do. The GNU tools are not in
it, so user shells keep the macOS tools.

## Test

Make an image, then run the image checks against it:

```bash
TEST_LUME_IMAGE=<image-vm> \
LUME_STORAGE_DIR=<folder> LUME_STATE_DIR=<folder> \
pnpm --filter @amika/sandbox test:integration src/providers/lume/macos-image
```

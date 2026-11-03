# macOS image for Lume rigs

`build.sh` makes the macOS image that Lume rigs clone (spec 026 in
amika-mono). It is apart from the Linux OCI images in `sandbox-image/`, but
uses the same version pins (`sandbox-image/versions.env`).

## Build

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

A failed build deletes its clone.

## What the image has

- The `amika` user, with home `/Users/amika` and `sudo` with no password.
- The base VM's bootstrap user `lume` / `lume`, and Remote Login. The rig's
  SSH bootstrap uses that password one time, then turns password login off.
- amikad in `/usr/local/bin`, and its launchd job in `/usr/local/lib/amikad`.
  launchd does not start amikad at boot. Provisioning loads the job after it
  sets new credentials.
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

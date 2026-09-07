---
name: release-commit-sandbox-image
description: "Create a release commit for a sandbox image version bump. Reads the version changes in sandbox-image/versions.env, verifies the generated bundle and its Go mirror are current, builds a changelog of the pinned-version changes, and creates a commit."
---

# Create Sandbox Image Release Commit

Create a release commit for a bump of the pinned tool versions in
`sandbox-image/versions.env`. This skill extracts every changed pin, verifies
the generated artifacts were regenerated, and creates a well-formatted commit
covering the source change and all generated files.

The sandbox image has no version tags of its own: the release *is* this commit.
Publishing happens afterwards, out of band (see step 7).

## Procedure

### Step 1: Extract the version changes

1. Run `git diff HEAD -- sandbox-image/versions.env` (covers staged and
   unstaged changes).
2. Parse each changed pin from lines like:
   ```
   -CLAUDE_CODE_VERSION=2.1.224
   +CLAUDE_CODE_VERSION=2.1.252
   ```
   Record `NAME`, `OLD_VERSION`, `NEW_VERSION` for each.
3. Also note pins that were **added** (no `-` line) or **removed** (no `+`
   line); report those separately from bumps.
4. If there is no change in `sandbox-image/versions.env`, error out: "No
   version change found in sandbox-image/versions.env".

### Step 2: Verify the generated bundle is current

Generated files are half of the change, and they must land in the same commit.

1. Run `python3 sandbox-image/generate.py --check`.
   - If it reports stale output, run `python3 sandbox-image/generate.py` and
     tell the user you regenerated.
2. Run `make test-sandbox-image`. If it fails, stop and report the failure —
   do not commit.
3. Confirm the working tree includes changes under both `sandbox-image/generated/`
   and the Go mirror `go/internal/sandbox/sandbox-image/`. If `versions.env`
   changed but neither did, something is wrong: stop and report it.

### Step 3: Check for unrelated changes

Run `git status --porcelain` and list any modified files outside
`sandbox-image/` and `go/internal/sandbox/sandbox-image/`. If there are any,
tell the user which ones and confirm before proceeding — this commit should
carry only the version bump and its generated output. Never stage untracked
junk such as `__pycache__/`.

### Step 4: Build the changelog

1. Format each bump as `- <NAME>: <OLD_VERSION> -> <NEW_VERSION>`, using the
   pin's lowercased, human name (e.g. `CLAUDE_CODE_VERSION` -> `claude-code`,
   `PI_WEB_VERSION` -> `pi-web`, `UBUNTU_TAG` -> `ubuntu`).
2. Keep the order they appear in `versions.env`.
3. For Amika's own components (`AMIKA_VERSION`, `AMIKALOG_VERSION`,
   `AMIKAD_VERSION`), the released tags exist in this repo — if
   `git log --oneline <symbol>@v<OLD>..<symbol>@v<NEW>` is short and
   informative, you may add a one-line summary of what that bump brings. Skip
   it if the log is long or noisy.
4. If the diff also touched `manifest.toml`, `steps/`, `assets/`, or `verify/`,
   summarize those changes in a separate list under an "Other changes:" heading.

### Step 5: Review commit message

1. Draft the commit message using this format:

```
[release sandbox-image] Bump pinned versions

Update the sandbox image tool pins and regenerate the bundle and its Go mirror.

Version changes:
<changelog entries from step 4>
```

   If a single pin changed, use a more specific subject, e.g.
   `[release sandbox-image] Bump amika to 0.18.0`.

2. Present the full draft commit message to the user using `AskUserQuestion`
   and ask them to review it. The user may request edits — apply any changes
   they ask for and re-present if needed.

### Step 6: Create commit

Only after the user approves the commit message:

1. Stage the source change and every generated file together:

   ```bash
   git add sandbox-image/ go/internal/sandbox/sandbox-image/
   ```

2. Create the commit with the approved message, adding the release trailer
   via `--trailer`:

   ```bash
   git commit \
     -m "[release sandbox-image] Bump pinned versions" \
     -m "Update the sandbox image tool pins and regenerate the bundle and its Go mirror.

   Version changes:
   <changelog entries from step 4>" \
     --trailer "Release-Component: sandbox-image"
   ```

   There is no `Release-Version` trailer: the sandbox image is not versioned as
   a unit, so the component trailer stands alone.

Do NOT include a `Co-Authored-By` line in the commit message.

### Step 7: Confirm and report next steps

1. Display the created commit (hash + full message) so the user can verify.
2. Remind the user of the follow-up, which this skill does not do:
   - A pull request for this commit should use the same
     `[release sandbox-image]` subject prefix; reuse the changelog from step 4
     as the PR body.
   - After it merges to `main`, the new image is published by manually running
     the **Build Daytona Snapshots** workflow
     (`.github/workflows/build-daytona-snapshots.yml`) from `main`.

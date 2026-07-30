---
name: create-cli-release-commit
description: "Create a release commit for a CLI version bump. Reads the version change in install.sh (DEFAULT_VERSION for amika or DEFAULT_AMIKALOG_VERSION for amikalog), generates a changelog from the git log between the old and new <symbol>@v* tags, and creates a commit."
---

# Create CLI Release Commit

Create a release commit based on a version change in `install.sh`. This skill detects which component is being released, extracts the old and new versions, generates a changelog from git history between the corresponding tags, and creates a well-formatted commit.

## Procedure

### Step 1: Detect the component and extract old and new versions

1. Run `git diff install.sh` (include both staged and unstaged changes).
2. Determine which version variable changed and set `SYMBOL` and `VAR` accordingly:
   - A change to `DEFAULT_VERSION` → `SYMBOL=amika`, `VAR=DEFAULT_VERSION`.
   - A change to `DEFAULT_AMIKALOG_VERSION` → `SYMBOL=amikalog`, `VAR=DEFAULT_AMIKALOG_VERSION`.
   - Match `VAR` exactly (`DEFAULT_VERSION` must not match `DEFAULT_AMIKALOG_VERSION`).
3. Parse the diff to find the old and new values for `VAR`. Look for lines like:
   ```
   -DEFAULT_VERSION="0.5.3"
   +DEFAULT_VERSION="0.6.0"
   ```
4. Error handling:
   - If neither `DEFAULT_VERSION` nor `DEFAULT_AMIKALOG_VERSION` changed in the diff, error out: "No version change found in install.sh".
   - If both changed, error out: "Both DEFAULT_VERSION and DEFAULT_AMIKALOG_VERSION changed; release one component at a time".
5. Record `OLD_VERSION` (the removed value) and `NEW_VERSION` (the added value).

### Step 2: Validate tags

1. Construct the tag names: `${SYMBOL}@v${OLD_VERSION}` and `${SYMBOL}@v${NEW_VERSION}`.
2. Verify both tags exist locally using `git rev-parse --verify <tag>`. If a tag is missing, error out and tell the user which tag is missing.

### Step 3: Generate changelog

1. Run `git log --oneline ${SYMBOL}@v${OLD_VERSION}..${SYMBOL}@v${NEW_VERSION}` to get the commit log between the two tags.
2. Filter out merge commits and release-tooling commits (e.g., commits that only bump version numbers). Keep substantive changes.
3. Group the commits into categories if natural groupings emerge, but do not force categorization for a small number of commits. Use your judgment.
4. Format each entry as a markdown list item: `- <concise description> (<short SHA>)`
   - Prefer the PR-style commit messages (the ones ending with `(#NNN)`) as they are the squash-merged versions. If both a squash-merge commit and its constituent commits appear in the log, prefer the squash-merge commit and omit the constituents.

### Step 4: Review commit message

1. Draft the commit message using this format (the subject line starts with `[release ${SYMBOL}]`):

```
[release ${SYMBOL}] Bump install.sh ${VAR} to ${NEW_VERSION}

Release ${SYMBOL}@v${NEW_VERSION}.

Changes since ${SYMBOL}@v${OLD_VERSION}:
<changelog entries from step 3>
```

2. Present the full draft commit message to the user using `AskUserQuestion` and ask them to review it. The user may request edits — apply any changes they ask for and re-present if needed.

### Step 5: Create commit

Only after the user approves the commit message:

1. Stage `install.sh`: `git add install.sh`
2. Create the commit with the approved message, adding structured release trailers via `--trailer`:

   ```bash
   git commit \
     -m "[release ${SYMBOL}] Bump install.sh ${VAR} to ${NEW_VERSION}" \
     -m "Release ${SYMBOL}@v${NEW_VERSION}.

   Changes since ${SYMBOL}@v${OLD_VERSION}:
   <changelog entries from step 3>" \
     --trailer "Release-Component: ${SYMBOL}" \
     --trailer "Release-Version: v${NEW_VERSION}"
   ```

Do NOT include a `Co-Authored-By` line in the commit message.

### Step 6: Confirm

Display the created commit (hash + full message) so the user can verify.

### Step 7: Pull request

If a pull request is opened for this release (now or later), its title must start with the same `[release ${SYMBOL}]` prefix, e.g. `[release ${SYMBOL}] Release ${SYMBOL}@v${NEW_VERSION}`. Reuse the changelog from step 3 as the PR body.

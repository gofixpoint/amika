---
name: create-cli-release-commit
description: "Create a release commit for a CLI version bump. Reads the DEFAULT_VERSION change in install.sh, generates a changelog from the git log between the old and new amika@v* tags, and creates a commit."
---

# Create CLI Release Commit

Create a release commit based on the `DEFAULT_VERSION` change in `install.sh`. This skill extracts the old and new versions, generates a changelog from git history between the corresponding tags, and creates a well-formatted commit.

## Procedure

### Step 1: Extract old and new versions

1. Run `git diff install.sh` (include both staged and unstaged changes).
2. Parse the diff to find the old and new `DEFAULT_VERSION` values. Look for lines like:
   ```
   -DEFAULT_VERSION="0.5.3"
   +DEFAULT_VERSION="0.6.0"
   ```
3. If there is no `DEFAULT_VERSION` change in the diff, error out: "No DEFAULT_VERSION change found in install.sh".
4. Record `OLD_VERSION` (the removed value) and `NEW_VERSION` (the added value).

### Step 2: Validate tags

1. Construct the tag names: `amika@v${OLD_VERSION}` and `amika@v${NEW_VERSION}`.
2. Verify both tags exist locally using `git rev-parse --verify <tag>`. If a tag is missing, error out and tell the user which tag is missing.

### Step 3: Generate changelog

1. Run `git log --oneline amika@v${OLD_VERSION}..amika@v${NEW_VERSION}` to get the commit log between the two tags.
2. Filter out merge commits and release-tooling commits (e.g., commits that only bump version numbers). Keep substantive changes.
3. Group the commits into categories if natural groupings emerge, but do not force categorization for a small number of commits. Use your judgment.
4. Format each entry as a markdown list item: `- <concise description> (<short SHA>)`
   - Prefer the PR-style commit messages (the ones ending with `(#NNN)`) as they are the squash-merged versions. If both a squash-merge commit and its constituent commits appear in the log, prefer the squash-merge commit and omit the constituents.

### Step 4: Review commit message

1. Draft the commit message using this format:

```
Bump install.sh DEFAULT_VERSION to ${NEW_VERSION}

Release amika@v${NEW_VERSION}.

Changes since amika@v${OLD_VERSION}:
<changelog entries from step 3>
```

2. Present the full draft commit message to the user using `AskUserQuestion` and ask them to review it. The user may request edits — apply any changes they ask for and re-present if needed.

### Step 5: Create commit

Only after the user approves the commit message:

1. Stage `install.sh`: `git add install.sh`
2. Create the commit with the approved message.

Do NOT include a `Co-Authored-By` line in the commit message.

### Step 6: Confirm

Display the created commit (hash + full message) so the user can verify.

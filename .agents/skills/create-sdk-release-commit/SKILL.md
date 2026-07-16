---
name: create-sdk-release-commit
description: "Create a release commit for a TypeScript SDK version bump. Reads the version change in sdk/typescript/package.json, generates a changelog from git history since the previous sdk-typescript@v* tag or version bump commit, and creates a commit."
---

# Create SDK Release Commit

Create a release commit based on the `version` change in `sdk/typescript/package.json`. This skill extracts the old and new versions, generates a changelog from git history, and creates a well-formatted commit.

Tags do not need to exist locally — they are created by CI after the PR merges to main.

## Procedure

### Step 1: Extract old and new versions

1. Run `git diff sdk/typescript/package.json` (include both staged and unstaged changes).
2. Parse the diff to find the old and new `version` values. Look for lines like:
   ```
   -  "version": "0.9.3",
   +  "version": "0.10.0",
   ```
3. If there is no `version` change in the diff, error out: "No version change found in sdk/typescript/package.json".
4. Record `OLD_VERSION` (the removed value) and `NEW_VERSION` (the added value).

### Step 2: Find the changelog boundary

Find the "from" boundary for the changelog using this priority order:

1. Try `git fetch --tags --quiet` to pull remote tags, then check if `sdk-typescript@v${OLD_VERSION}` now exists locally. If it does, use it as the boundary.
2. If the tag still isn't available, search the git log for the previous version bump commit: `git log --oneline --all -- sdk/typescript/package.json` and find the commit that set the version to `${OLD_VERSION}` (e.g. a commit message like "Bump TypeScript SDK version to 0.9.3" or "Release TypeScript SDK 0.9.3"). Prefer the PR squash-merge form (message ending with `(#NNN)`) over pre-merge feature branch commits, since the squash-merge is the one on `main` and gives the correct ancestry. Use that commit SHA as the boundary.
3. If neither works, report the issue and ask the user how to proceed.

### Step 3: Generate changelog

1. Run `git log --oneline <boundary>..HEAD` to get the commit log since the boundary. Optionally scope to `-- sdk/typescript/` to reduce noise if there are many unrelated commits, but include any SDK-relevant changes from across the repo.
2. Filter out merge commits and release-tooling commits (e.g., commits that only bump version numbers). Keep substantive changes.
3. Group the commits into categories if natural groupings emerge, but do not force categorization for a small number of commits. Use your judgment.
4. Format each entry as a markdown list item: `- <concise description> (<short SHA>)`
   - Prefer the PR-style commit messages (the ones ending with `(#NNN)`) as they are the squash-merged versions. If both a squash-merge commit and its constituent commits appear in the log, prefer the squash-merge commit and omit the constituents.

### Step 4: Review commit message

1. Draft the commit message using this format:

```
Bump TypeScript SDK version to ${NEW_VERSION}

Release sdk-typescript@v${NEW_VERSION}.

Changes since sdk-typescript@v${OLD_VERSION}:
<changelog entries from step 3>
```

2. Present the full draft commit message to the user using `AskUserQuestion` and ask them to review it. The user may request edits — apply any changes they ask for and re-present if needed.

### Step 5: Create commit

Only after the user approves the commit message:

1. Stage `sdk/typescript/package.json`: `git add sdk/typescript/package.json`
2. Create the commit with the approved message.

Do NOT include a `Co-Authored-By` line in the commit message.

### Step 6: Confirm

Display the created commit (hash + full message) so the user can verify.

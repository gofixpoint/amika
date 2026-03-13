---
name: make-stacked-prs
description: "Create stacked GitHub PRs from a linear chain of git branches. Use when the user wants to create stacked PRs, make a PR stack, or open multiple PRs from a chain of branches. Args: <first-branch> [<last-branch>] [<onto-base-branch>]"
argument-hint: "<first-branch> [<last-branch>] [<onto-base-branch>]"
---

# Create Stacked PRs

Create stacked GitHub PRs from a linear chain of git branches. Each PR targets the previous branch in the chain, making code review easier for large changesets broken into logical steps.

**Usage:** `/make-stacked-prs <first-branch> [<last-branch>] [<onto-base-branch>]`

- `first-branch` (required): The earliest branch in the chain
- `last-branch` (optional): The latest branch in the chain. Defaults to the current branch.
- `onto-base-branch` (optional): The branch the first PR targets. Defaults to `main` (falls back to `master`).

## Procedure

### Step 1: Parse arguments and record state

1. Parse `$ARGUMENTS`: 1st = first-branch (required), 2nd = last-branch (optional), 3rd = onto-base-branch (optional).
2. If `last-branch` is not provided, default to the current branch.
3. If `onto-base-branch` is not provided, it will be determined in pre-flight checks.
4. Record the current branch via `git rev-parse --abbrev-ref HEAD` so we can restore it during cleanup.

### Step 2: Pre-flight checks

Run all of the following checks. If any fail, stop and report the error.

1. **Clean working tree**: Run `git diff --quiet HEAD`. Only tracked files matter; untracked files are fine. If the working tree is dirty, error out and ask the user to commit or stash changes.
2. **Determine `onto-base-branch`** (if not provided): Check if `main` exists (`git rev-parse --verify main`). If not, try `master`. If neither exists, error out.
3. **Verify all branches exist**: Run `git rev-parse --verify` for `first-branch`, `last-branch`, and `onto-base-branch`. Error if any are missing.
4. **Verify linear ancestry**: Run `git merge-base --is-ancestor <first-branch> <last-branch>`. If `first-branch` == `last-branch`, this is a valid single-branch stack — skip this check. Otherwise, error if first-branch is not an ancestor of last-branch.

### Step 3: Discover branches in the chain

1. Get commit hashes in range: `git log --format='%H' <first-branch>^..<last-branch>`
   - **Edge case**: If `first-branch` is the root commit, `first-branch^` will fail. In that case, use `git log --format='%H' <last-branch>` (all commits up to last-branch) and filter appropriately.
2. Get all local branches and their SHAs: `git for-each-ref --format='%(objectname) %(refname:short)' refs/heads/`
3. Intersect: find branches that point at commits in the range from step 1.
4. Order them oldest-to-newest by commit position in the log.
5. **Error if two branches point to the same commit** — this is ambiguous ordering. List the conflicting branches and ask the user to resolve (e.g., delete or move one).
6. The result must include at least `first-branch` and `last-branch`.

### Step 4: Check for existing PRs

For **every** branch discovered in step 3, check for existing PRs:

```
gh pr list --head <branch> --json number,url --limit 1
```

If **any** branch already has an open PR, **error out completely**. List all branches that have existing PRs with their PR URLs. Do not proceed — the user must close or handle those PRs first.

This check is non-negotiable. Even if the user later removes branches from the creation list in step 5, the check in this step must have passed for all discovered branches.

### Step 5: Confirm branch list with user

Display the ordered chain showing each branch and its intended base:

```
Stack to create:
  1. <first-branch>  →  base: <onto-base-branch>
  2. <branch-B>      →  base: <first-branch>
  3. <last-branch>   →  base: <branch-B>
```

Use `AskUserQuestion` to confirm. The user may remove intermediate branches from the list but cannot bypass the step-4 existing-PR check.

### Step 6: Push branches and create PRs

Process each branch **one at a time, in order**:

1. **Determine base**: `onto-base-branch` for the first branch; the previous branch in the chain for all others.
2. **Push**: `git push origin <branch>`. If it fails, ask the user how to proceed (force push, skip, abort).
3. **Generate title and body** by examining:
   - Commit log with changed files: `git log --name-status <base>..<branch>` (use `$(git merge-base <onto-base-branch> <first-branch>)..<first-branch>` if `onto-base-branch` is not a direct ancestor of `first-branch`)
   - Diff content: `git diff <base>...<branch>` to understand the actual changes
4. **PR body must include**:
   - A **stack navigation list** showing all branches in the chain. This should go at the bottom of the PR body. Each entry shows the branch name. For the current PR, show `` `#THIS` ← you are here `` (no link). For other PRs already created, link with `#<number>`. For PRs not yet created, show "(PR pending)". Example:
     ```
     ## Stack

     1. `first-branch` #12
     2. `branch-B` `#THIS` ← you are here
     3. `branch-C` (PR pending)
     ```
   - A summary of changes derived from the commits and diff.
5. **Show the proposed title, body, and base branch to the user.** Use `AskUserQuestion` to confirm before running `gh pr create`.
6. Create the PR: `gh pr create --base <base> --head <branch> --title "<title>" --body "<body>"`

After **all** PRs are created, go back and update the bodies of earlier PRs to fill in PR links that weren't available when those PRs were created. Use `gh pr edit <number> --body "<updated-body>"` for each PR that had "(PR pending)" placeholders. When updating, keep the self-reference as `` `#THIS` ← you are here `` (never link a PR to itself).

### Step 7: Cleanup

1. Restore the original branch: `git checkout <original-branch>`
2. Display a summary of all created PRs with their URLs:
   ```
   Created 3 stacked PRs:
     1. `first-branch` #12 <url> (→ onto-base-branch)
     2. `branch-B` #13 <url> (→ first-branch)
     3. `last-branch` #14 <url> (→ branch-B)
   ```

## Edge Cases

- **`first-branch` == `last-branch`**: Valid single-PR stack. Creates one PR targeting `onto-base-branch`.
- **No intermediate branches**: Only `first-branch` and `last-branch` exist in the range. Creates two PRs.
- **Root commit as `first-branch`**: Handle `first-branch^` failure gracefully in step 3 by not using the `^` suffix.
- **Two branches on same commit**: Error in step 3, ask the user to resolve the ambiguity.

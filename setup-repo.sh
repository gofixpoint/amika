#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")" && pwd)"

errcho() {
    printf "%s\n" "$*" >&2
}

# Resolve the main worktree path, handling the case where REPO_ROOT is a
# linked worktree (its .git is a file pointing at the main worktree's gitdir).
cmd_mainpath() {
    local git_root
    git_root=$(git -C "$REPO_ROOT" rev-parse --show-toplevel)
    local dotgit="${git_root}/.git"

    if [ -d "$dotgit" ]; then
        echo "$git_root"
    elif [ -f "$dotgit" ]; then
        # .git file contains e.g. "gitdir: /path/to/main/.git/worktrees/name"
        local gitdir
        gitdir=$(sed 's/^gitdir: //' "$dotgit")
        # Strip from the last ".git/" onwards to get the main worktree path
        echo "${gitdir%.git/*}"
    else
        errcho "error: could not determine main worktree"
        exit 1
    fi
}

# Copy the main worktree's .env.local into this worktree if it exists.
cp "$(cmd_mainpath)/.env.local" "$REPO_ROOT/" 2>/dev/null || true

git config core.hooksPath "$REPO_ROOT/githooks"

echo "Git hooks path configured to: $REPO_ROOT/githooks"

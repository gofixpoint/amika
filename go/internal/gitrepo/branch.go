package gitrepo

// branch.go answers which branch a remote sandbox should be cut from: the one
// checked out locally, and whether the remote already has it.

import (
	"fmt"
	"os/exec"
	"strings"
)

// BranchRequest is the branch pair a command collected from its flags.
// Both empty means "decide from the working directory".
type BranchRequest struct {
	// Branch is --branch: check out this branch, creating it if the remote
	// has none. It is also the base --new-branch is cut from.
	Branch string
	// NewBranch is --new-branch: cut a new branch from Branch.
	NewBranch string
}

// ResolveBranch fills in the branch a remote sandbox should be cut from and
// refuses the case where the caller would silently get different code.
//
// Whenever --branch is absent, the checked-out branch becomes the base: a
// sandbox for "the thing I am working on" should hold that thing, and a new
// branch should be cut from it. Leaving the base empty would hand the server
// nothing to start from, so it would use its default branch instead. That is
// same code the caller is not looking at.
//
// An inferred base must exist on the remote, since that is where the sandbox
// clones from. If it does not, the sandbox would quietly come up on the
// default branch, so this is an error rather than a warning. A base named
// explicitly with --branch is the caller's stated intent and is passed
// through: the server creates it when the remote has none.
//
// A URL source has no local checkout to read, so its pair passes through and
// the server applies its own default.
func ResolveBranch(identity Identity, req BranchRequest) (BranchRequest, error) {
	if !identity.IsLocalPath() || req.Branch != "" {
		return req, nil
	}
	current, err := CurrentBranch(identity.Path)
	if err != nil {
		return BranchRequest{}, err
	}
	if !BranchReachableFromRemote(identity.Path, current) {
		return BranchRequest{}, fmt.Errorf(
			"current branch %q has not been pushed or is not up-to-date with the remote\n\n"+
				"The sandbox clones from the remote, so it would start from an older\n"+
				"version of this branch or from the default branch instead.\n\n"+
				"Push your branch first, or use --branch to name the branch to start from.",
			current)
	}
	req.Branch = current
	return req, nil
}

// BranchReachableFromRemote reports whether the local branch tip
// is an ancestor of (or equal to) the corresponding branch on the "origin"
// remote. This means the remote already contains every commit on the local
// branch, so it is safe to create a sandbox from the remote version.
//
// It always checks against origin directly (not the upstream tracking
// branch) because sandbox creation resolves the origin URL regardless of
// what remote the branch tracks.
//
// The ancestry check uses "git merge-base --is-ancestor", which requires
// both SHAs to be in the local object store. If the remote tip has not been
// fetched, fetch that exact advertised object without updating FETCH_HEAD or
// any refs. Comparing with a stale tracking ref is not sufficient because the
// remote branch may have been force-pushed since the last fetch.
func BranchReachableFromRemote(repoDir, branch string) bool {
	// Query origin for the branch tip SHA without downloading objects.
	remoteRef := "refs/heads/" + branch
	lsCmd := exec.Command("git", "-C", repoDir, "ls-remote", "--heads", "origin", remoteRef)
	lsOut, err := lsCmd.Output()
	if err != nil || strings.TrimSpace(string(lsOut)) == "" {
		return false // branch doesn't exist on origin
	}
	remoteSHA := strings.Fields(strings.TrimSpace(string(lsOut)))[0]

	// Get the local branch tip SHA.
	localRef := "refs/heads/" + branch + "^{commit}"
	localCmd := exec.Command("git", "-C", repoDir, "rev-parse", "--verify", localRef)
	localOut, err := localCmd.Output()
	if err != nil {
		return false
	}
	localSHA := strings.TrimSpace(string(localOut))

	// Fast path: tips match exactly.
	if remoteSHA == localSHA {
		return true
	}

	// Download an unfetched remote tip without moving a local ref. Fetching the
	// exact SHA also keeps the ancestry check tied to the ls-remote result if
	// the branch moves between the two commands.
	catCmd := exec.Command("git", "-C", repoDir, "cat-file", "-e", remoteSHA)
	if catCmd.Run() != nil {
		fetchCmd := exec.Command(
			"git", "-C", repoDir, "fetch", "--quiet", "--no-tags",
			"--no-write-fetch-head", "origin", remoteSHA,
		)
		if fetchCmd.Run() != nil {
			return false
		}
	}

	// "merge-base --is-ancestor A B" exits 0 when A is an ancestor of B,
	// meaning the remote (B) contains every commit in local (A).
	ancestorCmd := exec.Command("git", "-C", repoDir, "merge-base", "--is-ancestor", localSHA, remoteSHA)
	return ancestorCmd.Run() == nil
}

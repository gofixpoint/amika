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
// nothing to start from, so it would use its default branch instead — the
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
	// A detached HEAD has no branch name to carry over; the server's default
	// is then the only answer available, so leave the pair as it is.
	current, err := CurrentBranch(identity.Path)
	if err != nil {
		return req, nil
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
// both SHAs to be in the local object store. The remote SHA (obtained via
// ls-remote) may not be local if the user hasn't fetched recently — the
// common case when someone else pushes to the branch. To avoid a fetch
// (which would mutate local state), we fall back to comparing against the
// last-fetched tracking ref (refs/remotes/origin/<branch>). If local
// hasn't moved past that ref, and the remote is even further ahead, then
// local is certainly behind remote and it is safe to proceed.
func BranchReachableFromRemote(repoDir, branch string) bool {
	// Query origin for the branch tip SHA without downloading objects.
	lsCmd := exec.Command("git", "-C", repoDir, "ls-remote", "--heads", "origin", branch)
	lsOut, err := lsCmd.Output()
	if err != nil || strings.TrimSpace(string(lsOut)) == "" {
		return false // branch doesn't exist on origin
	}
	remoteSHA := strings.Fields(strings.TrimSpace(string(lsOut)))[0]

	// Get the local branch tip SHA.
	localCmd := exec.Command("git", "-C", repoDir, "rev-parse", branch)
	localOut, err := localCmd.Output()
	if err != nil {
		return false
	}
	localSHA := strings.TrimSpace(string(localOut))

	// Fast path: tips match exactly.
	if remoteSHA == localSHA {
		return true
	}

	// Check whether the remote SHA exists in the local object store. It
	// will be present if the user has fetched recently, or if the commit
	// was created locally and then pushed.
	catCmd := exec.Command("git", "-C", repoDir, "cat-file", "-e", remoteSHA)
	if catCmd.Run() == nil {
		// Remote SHA is local — do a precise ancestry check.
		// "merge-base --is-ancestor A B" exits 0 when A is an ancestor of B,
		// meaning the remote (B) contains every commit in local (A).
		ancestorCmd := exec.Command("git", "-C", repoDir, "merge-base", "--is-ancestor", localSHA, remoteSHA)
		return ancestorCmd.Run() == nil
	}

	// Remote SHA is NOT in the local object store (e.g. someone else pushed
	// new commits and we haven't fetched). Fall back to the last-fetched
	// tracking ref: if local hasn't moved past origin/<branch>, then local
	// has no unpushed commits and must be behind the (even newer) remote.
	trackingRef := "refs/remotes/origin/" + branch
	verifyCmd := exec.Command("git", "-C", repoDir, "rev-parse", "--verify", "--quiet", trackingRef)
	if verifyCmd.Run() != nil {
		return false // no tracking ref — can't determine relationship
	}
	trackingAncestorCmd := exec.Command("git", "-C", repoDir, "merge-base", "--is-ancestor", localSHA, trackingRef)
	return trackingAncestorCmd.Run() == nil
}

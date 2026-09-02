package sandboxcmd

// sandbox_create_git.go prepares git-backed sandbox mounts and branch state.

import (
	"fmt"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"sort"
	"strings"

	"github.com/gofixpoint/amika/go/internal/gitrepo"
	"github.com/gofixpoint/amika/go/internal/sandbox"
)

type gitMountInfo struct {
	RepoName string
	RepoRoot string
	NoClean  bool
	Mount    sandbox.MountBinding
}

func prepareGitMount(startPath string, noClean bool, cloneFn func(src, dst string) error, branch, newBranch string) (gitMountInfo, func(), error) {
	repoRoot, err := gitrepo.ResolveRoot(startPath)
	if err != nil {
		return gitMountInfo{}, func() {}, err
	}

	repoName := filepath.Base(repoRoot)
	target := path.Join(sandbox.SandboxWorkdir, repoName)
	tmpDir, err := os.MkdirTemp("", "amika-git-mount-*")
	if err != nil {
		return gitMountInfo{}, func() {}, fmt.Errorf("failed to create temp directory for git mount: %w", err)
	}
	preparedRepo := filepath.Join(tmpDir, repoName)
	if noClean {
		if err := copyRepoWorkingTree(repoRoot, preparedRepo); err != nil {
			_ = os.RemoveAll(tmpDir)
			return gitMountInfo{}, func() {}, err
		}
	} else {
		if err := cloneFn(repoRoot, preparedRepo); err != nil {
			_ = os.RemoveAll(tmpDir)
			return gitMountInfo{}, func() {}, err
		}
	}
	if err := applyBranchCheckout(preparedRepo, branch, newBranch); err != nil {
		_ = os.RemoveAll(tmpDir)
		return gitMountInfo{}, func() {}, err
	}
	if err := syncGitRemotes(repoRoot, preparedRepo); err != nil {
		_ = os.RemoveAll(tmpDir)
		return gitMountInfo{}, func() {}, err
	}
	cleanup := func() { _ = os.RemoveAll(tmpDir) }

	return gitMountInfo{
		RepoName: repoName,
		RepoRoot: repoRoot,
		NoClean:  noClean,
		Mount: sandbox.MountBinding{
			Type:         "bind",
			Source:       preparedRepo,
			Target:       target,
			Mode:         "rwcopy",
			SnapshotFrom: repoRoot,
		},
	}, cleanup, nil
}

func cloneGitRepo(src, dst string) error {
	args := []string{"clone", "--local", "--no-hardlinks", src, dst}
	cmd := exec.Command("git", args...)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("failed to prepare clean git mount from %q: %s", src, strings.TrimSpace(string(out)))
	}
	return nil
}

func cloneGitURL(src, dst string) error {
	cmd := exec.Command("git", "clone", src, dst)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("failed to clone %q: %s", src, strings.TrimSpace(string(out)))
	}
	return nil
}

// prepareGitMountFromURL clones a remote URL into a temporary directory and
// returns a mount that exposes the cloned tree to the sandbox.
//
// Unlike prepareGitMount (which copies a host repo and must re-sync remotes
// from the source so the sandbox sees the same origin/upstream), the URL
// path delegates to "git clone <url>", which already configures origin
// pointing at rawURL. No additional remote sync is needed.
func prepareGitMountFromURL(rawURL string, cloneFn func(src, dst string) error, branch, newBranch string) (gitMountInfo, func(), error) {
	name, err := gitrepo.NameFromURL(rawURL)
	if err != nil {
		return gitMountInfo{}, func() {}, err
	}
	target := path.Join(sandbox.SandboxWorkdir, name)
	tmpDir, err := os.MkdirTemp("", "amika-git-mount-*")
	if err != nil {
		return gitMountInfo{}, func() {}, fmt.Errorf("failed to create temp directory for git mount: %w", err)
	}
	preparedRepo := filepath.Join(tmpDir, name)
	if err := cloneFn(rawURL, preparedRepo); err != nil {
		_ = os.RemoveAll(tmpDir)
		return gitMountInfo{}, func() {}, err
	}
	if err := applyBranchCheckout(preparedRepo, branch, newBranch); err != nil {
		_ = os.RemoveAll(tmpDir)
		return gitMountInfo{}, func() {}, err
	}
	cleanup := func() { _ = os.RemoveAll(tmpDir) }
	return gitMountInfo{
		RepoName: name,
		RepoRoot: rawURL,
		NoClean:  false,
		Mount: sandbox.MountBinding{
			Type:         "bind",
			Source:       preparedRepo,
			Target:       target,
			Mode:         "rwcopy",
			SnapshotFrom: rawURL,
		},
	}, cleanup, nil
}

func branchOrRemoteExists(repoDir, branch string) bool {
	for _, ref := range []string{"refs/heads/" + branch, "refs/remotes/origin/" + branch} {
		cmd := exec.Command("git", "-C", repoDir, "rev-parse", "--verify", "--quiet", ref)
		if err := cmd.Run(); err == nil {
			return true
		}
	}
	return false
}

func localBranchExists(repoDir, branch string) bool {
	cmd := exec.Command("git", "-C", repoDir, "rev-parse", "--verify", "--quiet", "refs/heads/"+branch)
	return cmd.Run() == nil
}

func remoteTrackingBranchExists(repoDir, branch string) bool {
	cmd := exec.Command("git", "-C", repoDir, "rev-parse", "--verify", "--quiet", "refs/remotes/origin/"+branch)
	return cmd.Run() == nil
}

func detectDefaultBranch(repoDir string) (string, error) {
	for _, b := range []string{"main", "master"} {
		if branchOrRemoteExists(repoDir, b) {
			return b, nil
		}
	}
	return "", fmt.Errorf("could not locate 'main' or 'master' branch; specify --branch explicitly")
}

func runGitInDir(dir string, args ...string) error {
	full := append([]string{"-C", dir}, args...)
	cmd := exec.Command("git", full...)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("git %s: %s", strings.Join(args, " "), strings.TrimSpace(string(out)))
	}
	return nil
}

func checkoutPreparedBranch(repoDir, branch string) error {
	switch {
	case localBranchExists(repoDir, branch):
		if err := runGitInDir(repoDir, "checkout", branch); err != nil {
			return fmt.Errorf("failed to checkout base branch %q: %w", branch, err)
		}
	case remoteTrackingBranchExists(repoDir, branch):
		if err := runGitInDir(repoDir, "checkout", "-B", branch, "refs/remotes/origin/"+branch); err != nil {
			return fmt.Errorf("failed to checkout base branch %q from origin/%s: %w", branch, branch, err)
		}
	default:
		return fmt.Errorf("base branch %q does not exist in the repository", branch)
	}
	return nil
}

func applyBranchCheckout(repoDir, branch, newBranch string) error {
	if newBranch != "" && branch == "" {
		if err := runGitInDir(repoDir, "checkout", "-b", newBranch); err != nil {
			return fmt.Errorf("failed to create branch %q: %w", newBranch, err)
		}
		return nil
	}

	if branch != "" {
		if branchOrRemoteExists(repoDir, branch) {
			if err := checkoutPreparedBranch(repoDir, branch); err != nil {
				return err
			}
		} else {
			if err := runGitInDir(repoDir, "checkout", "-b", branch); err != nil {
				return fmt.Errorf("failed to create branch %q: %w", branch, err)
			}
		}
	}

	if newBranch != "" {
		if err := runGitInDir(repoDir, "checkout", "-b", newBranch); err != nil {
			return fmt.Errorf("failed to create branch %q: %w", newBranch, err)
		}
	}
	return nil
}

// isLocalBranchReachableFromRemote returns true when the local branch tip
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
func isLocalBranchReachableFromRemote(repoDir, branch string) bool {
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

func copyRepoWorkingTree(src, dst string) error {
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return fmt.Errorf("failed to create no-clean parent for %q: %w", dst, err)
	}
	cmd := exec.Command("cp", "-a", src, dst)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("failed to prepare no-clean git mount from %q: %s", src, strings.TrimSpace(string(out)))
	}
	if _, err := os.Stat(filepath.Join(dst, ".git")); err != nil {
		return fmt.Errorf("failed to prepare no-clean git mount from %q: missing .git in %q", src, dst)
	}
	return nil
}

func syncGitRemotes(srcRepo, dstRepo string) error {
	srcRemotes, err := gitrepo.ListRemotes(srcRepo)
	if err != nil {
		return fmt.Errorf("failed to read remotes from source repo %q: %w", srcRepo, err)
	}
	filtered := make(map[string]string)
	for name, url := range srcRemotes {
		if gitrepo.IsNetworkURL(url) {
			filtered[name] = url
		}
	}

	dstRemotes, err := gitrepo.ListRemotes(dstRepo)
	if err != nil {
		return fmt.Errorf("failed to read remotes from prepared repo %q: %w", dstRepo, err)
	}
	for _, name := range sortedRemoteNames(dstRemotes) {
		if err := gitrepo.Run(dstRepo, "remote", "remove", name); err != nil {
			return fmt.Errorf("failed to remove remote %q from prepared repo %q: %w", name, dstRepo, err)
		}
	}
	for _, name := range sortedRemoteNames(filtered) {
		if err := gitrepo.Run(dstRepo, "remote", "add", name, filtered[name]); err != nil {
			return fmt.Errorf("failed to add remote %q to prepared repo %q: %w", name, dstRepo, err)
		}
	}
	return nil
}

func sortedRemoteNames(m map[string]string) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

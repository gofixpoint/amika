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

	"github.com/gofixpoint/amika/internal/sandbox"
)

type gitMountInfo struct {
	RepoName string
	RepoRoot string
	NoClean  bool
	Mount    sandbox.MountBinding
}

func prepareGitMount(startPath string, noClean bool, cloneFn func(src, dst string) error, branch, newBranch string) (gitMountInfo, func(), error) {
	repoRoot, err := resolveGitRoot(startPath)
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

func resolveGitRoot(startPath string) (string, error) {
	if startPath == "" {
		startPath = "."
	}
	absPath, err := filepath.Abs(startPath)
	if err != nil {
		return "", fmt.Errorf("failed to resolve git start path %q: %w", startPath, err)
	}

	current := absPath
	if stat, err := os.Stat(absPath); err == nil && !stat.IsDir() {
		current = filepath.Dir(absPath)
	}

	for {
		gitMarker := filepath.Join(current, ".git")
		if _, err := os.Stat(gitMarker); err == nil {
			return current, nil
		}

		parent := filepath.Dir(current)
		if parent == current {
			break
		}
		current = parent
	}

	return "", fmt.Errorf("no git repository root found from %q", absPath)
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

func detectHostCurrentBranch(startPath string) (string, error) {
	repoRoot, err := resolveGitRoot(startPath)
	if err != nil {
		return "", err
	}
	cmd := exec.Command("git", "-C", repoRoot, "rev-parse", "--abbrev-ref", "HEAD")
	out, err := cmd.Output()
	if err != nil {
		return "", fmt.Errorf("failed to detect current host branch: %w", err)
	}
	name := strings.TrimSpace(string(out))
	if name == "" || name == "HEAD" {
		return "", fmt.Errorf("detached HEAD; specify --branch explicitly")
	}
	return name, nil
}

// isBranchPushedToRemote checks whether the given branch has been pushed to
// its upstream remote. Returns false if the branch has no upstream tracking
// branch (never pushed) or if there are local commits not yet pushed.
func isBranchPushedToRemote(repoDir, branch string) bool {
	// Check if the branch has an upstream tracking ref set.
	upstreamCmd := exec.Command("git", "-C", repoDir, "rev-parse", "--abbrev-ref", branch+"@{upstream}")
	upstreamOut, err := upstreamCmd.Output()
	if err != nil {
		return false // No upstream configured — branch was never pushed
	}
	upstream := strings.TrimSpace(string(upstreamOut))
	if upstream == "" {
		return false
	}

	// Check if there are local commits ahead of the upstream.
	countCmd := exec.Command("git", "-C", repoDir, "rev-list", "--count", upstream+".."+branch)
	countOut, err := countCmd.Output()
	if err != nil {
		return false
	}
	return strings.TrimSpace(string(countOut)) == "0"
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
	srcRemotes, err := listGitRemotes(srcRepo)
	if err != nil {
		return fmt.Errorf("failed to read remotes from source repo %q: %w", srcRepo, err)
	}
	filtered := make(map[string]string)
	for name, url := range srcRemotes {
		if isNetworkRemoteURL(url) {
			filtered[name] = url
		}
	}

	dstRemotes, err := listGitRemotes(dstRepo)
	if err != nil {
		return fmt.Errorf("failed to read remotes from prepared repo %q: %w", dstRepo, err)
	}
	for _, name := range sortedRemoteNames(dstRemotes) {
		if err := runGit(dstRepo, "remote", "remove", name); err != nil {
			return fmt.Errorf("failed to remove remote %q from prepared repo %q: %w", name, dstRepo, err)
		}
	}
	for _, name := range sortedRemoteNames(filtered) {
		if err := runGit(dstRepo, "remote", "add", name, filtered[name]); err != nil {
			return fmt.Errorf("failed to add remote %q to prepared repo %q: %w", name, dstRepo, err)
		}
	}
	return nil
}

func listGitRemotes(repo string) (map[string]string, error) {
	out, err := runGitOutput(repo, "remote")
	if err != nil {
		return nil, err
	}
	names := strings.Fields(strings.TrimSpace(out))
	remotes := make(map[string]string, len(names))
	for _, name := range names {
		url, err := runGitOutput(repo, "remote", "get-url", name)
		if err != nil {
			return nil, err
		}
		remotes[name] = strings.TrimSpace(url)
	}
	return remotes, nil
}

func isNetworkRemoteURL(url string) bool {
	switch {
	case strings.HasPrefix(url, "http://"),
		strings.HasPrefix(url, "https://"),
		strings.HasPrefix(url, "ssh://"):
		return true
	case strings.HasPrefix(url, "file://"):
		return false
	}
	at := strings.Index(url, "@")
	colon := strings.Index(url, ":")
	return at > 0 && colon > at+1
}

func sortedRemoteNames(m map[string]string) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

func runGit(repo string, args ...string) error {
	_, err := runGitOutput(repo, args...)
	return err
}

func runGitOutput(repo string, args ...string) (string, error) {
	cmdArgs := append([]string{"-C", repo}, args...)
	cmd := exec.Command("git", cmdArgs...)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("git %s failed: %s", strings.Join(args, " "), strings.TrimSpace(string(out)))
	}
	return string(out), nil
}

func resolveGitURL(value string) (string, error) {
	if strings.HasPrefix(value, "http://") || strings.HasPrefix(value, "https://") || strings.HasPrefix(value, "git@") {
		return value, nil
	}

	repoRoot, err := resolveGitRoot(value)
	if err != nil {
		return "", fmt.Errorf("could not find git repo at %q: %w", value, err)
	}
	remotes, err := listGitRemotes(repoRoot)
	if err != nil {
		return "", err
	}
	origin, ok := remotes["origin"]
	if !ok {
		return "", fmt.Errorf("no origin remote found in %q; specify a git HTTP(S) or SSH URL directly with --git <url>", repoRoot)
	}
	if !isNetworkRemoteURL(origin) {
		return "", fmt.Errorf("origin remote %q is a local path; specify a git HTTP(S) or SSH URL directly with --git <url>", origin)
	}
	return origin, nil
}

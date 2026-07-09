package eventlog

import (
	"context"
	"os/exec"
	"strings"
	"time"
)

// gitTimeout bounds each git invocation so a wedged git process can never hang
// an agent's hook.
const gitTimeout = 5 * time.Second

// GatherGit returns the git state of dir, or nil when dir is not inside a git
// repository or git is unavailable. It never returns an error: capturing the
// event must not fail just because git context could not be collected.
func GatherGit(dir string) *GitInfo {
	if dir == "" {
		return nil
	}
	root, ok := gitOutput(dir, "rev-parse", "--show-toplevel")
	if !ok || root == "" {
		return nil
	}
	// HEAD lookups fail in a repository with no commits yet; that is fine, we
	// still record the repo root and dirty state with an empty commit/branch.
	commit, _ := gitOutput(dir, "rev-parse", "HEAD")
	branch, _ := gitOutput(dir, "rev-parse", "--abbrev-ref", "HEAD")
	status, _ := gitOutput(dir, "status", "--porcelain")
	// The "origin" remote gives the repository a stable identity independent of
	// where it happens to be checked out. A repo with no "origin" (or none at
	// all) simply records an empty Remote and is later filed under its basename.
	remote, _ := gitOutput(dir, "remote", "get-url", "origin")
	return &GitInfo{
		RepoRoot: root,
		Remote:   normalizeRemoteURL(remote),
		Commit:   commit,
		Branch:   branch,
		Dirty:    strings.TrimSpace(status) != "",
	}
}

// normalizeRemoteURL reduces a git remote URL to a stable "host/owner/repo"
// identity, dropping the scheme, any credentials, a port, and a trailing
// ".git". It understands the forms git prints for "remote get-url": scheme
// URLs (https://, ssh://, git://) and the scp-like "git@host:owner/repo" form.
// It returns "" for input it cannot resolve to both a host and a path — an
// empty string, or a local "file://"/filesystem remote — so the caller falls
// back to the repository basename.
func normalizeRemoteURL(raw string) string {
	s := strings.TrimSpace(raw)
	if s == "" {
		return ""
	}

	var host, remotePath string
	if i := strings.Index(s, "://"); i >= 0 {
		// scheme://[user@]host[:port]/path
		rest := s[i+3:]
		slash := strings.IndexByte(rest, '/')
		if slash < 0 {
			return ""
		}
		host, remotePath = stripUserinfo(rest[:slash]), rest[slash+1:]
		host = stripPort(host)
	} else {
		// scp-like: [user@]host:owner/repo (the colon is the path separator, not
		// a port), so a port cannot appear here.
		colon := strings.IndexByte(s, ':')
		if colon < 0 {
			return ""
		}
		host, remotePath = stripUserinfo(s[:colon]), s[colon+1:]
	}

	remotePath = strings.TrimSuffix(strings.Trim(remotePath, "/"), ".git")
	remotePath = strings.Trim(remotePath, "/")
	if host == "" || remotePath == "" {
		return ""
	}
	return host + "/" + remotePath
}

// stripUserinfo removes a leading "user@" (or "user:pass@") from a URL
// authority component.
func stripUserinfo(authority string) string {
	if at := strings.LastIndexByte(authority, '@'); at >= 0 {
		return authority[at+1:]
	}
	return authority
}

// stripPort removes a trailing ":port" from a host authority, leaving hosts
// without a port untouched.
func stripPort(host string) string {
	if i := strings.LastIndexByte(host, ':'); i >= 0 {
		return host[:i]
	}
	return host
}

// gitOutput runs `git -C dir <args...>` and returns its trimmed stdout. The
// boolean reports success; callers treat failure as "information unavailable".
func gitOutput(dir string, args ...string) (string, bool) {
	ctx, cancel := context.WithTimeout(context.Background(), gitTimeout)
	defer cancel()
	full := append([]string{"-C", dir}, args...)
	out, err := exec.CommandContext(ctx, "git", full...).Output()
	if err != nil {
		return "", false
	}
	return strings.TrimSpace(string(out)), true
}

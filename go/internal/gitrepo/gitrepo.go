// Package gitrepo resolves which git repo (if any) should back a sandbox: the
// shared --git / --no-git flag pair, auto-detection from the working
// directory, and the "origin" URL a remote sandbox has to clone.
//
// It is shared by `amika sandbox create` and `amika send` so that running
// either from inside a repo picks up the same repo, with the same flags and
// the same error messages.
package gitrepo

import (
	"fmt"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

// Source records where a resolved repo came from, which decides how it is
// handed to the sandbox: a local path is copied or cloned locally, a URL is
// cloned from the network, and SourceNone means no repo at all.
type Source int

const (
	// SourceNone means no repo backs the sandbox, either because --no-git was
	// passed or because no repo was found from the working directory.
	SourceNone Source = iota
	// SourceAutoDetect means the repo was found by walking up from the
	// working directory.
	SourceAutoDetect
	// SourceFlagPath means --git named a local path.
	SourceFlagPath
	// SourceFlagURL means --git named a git URL (HTTPS or SSH).
	SourceFlagURL
)

// Identity is the repo a command resolved from its flags and working
// directory. Path is set for the local-path sources, URL for a URL source,
// and Name is the repo's short name in both cases.
type Identity struct {
	Name   string
	Source Source
	Path   string
	URL    string
}

// IsLocalPath reports whether the identity names a repo on this machine,
// as opposed to a URL or no repo at all.
func (i Identity) IsLocalPath() bool {
	return i.Source == SourceAutoDetect || i.Source == SourceFlagPath
}

// RemoteURL returns the git URL a remote sandbox should clone: the URL from
// --git as given, or the "origin" remote of a local-path repo. An identity
// with no repo returns an empty string and no error.
//
// Any embedded credential is stripped. The server clones with the GitHub auth
// the user configured there and never uses one supplied in the URL, so sending
// it would leak a secret to no purpose — and origins written by Amika's own
// sandbox provisioning carry a live token. Local cloning reads Identity.URL
// directly and so keeps whatever credential it needs.
func (i Identity) RemoteURL() (string, error) {
	switch i.Source {
	case SourceFlagURL:
		return StripCredentials(i.URL), nil
	case SourceAutoDetect, SourceFlagPath:
		url, err := ResolveURL(i.Path)
		if err != nil {
			return "", err
		}
		return StripCredentials(url), nil
	default:
		return "", nil
	}
}

// StripCredentials removes a credential embedded in a git URL, leaving an ssh
// username in place.
//
// For http(s) the whole userinfo is a credential — a GitHub App token arrives
// as `https://x-access-token:<token>@…` and a PAT is often pasted as
// `https://<pat>@…`, so the secret can be on either side of the colon and both
// halves go. For ssh:// and the scp-like `user@host:path`, the username is how
// ssh picks an account (`git@github.com` will not authenticate as anything
// else), so only a password half is dropped.
func StripCredentials(rawURL string) string {
	if i := strings.Index(rawURL, "://"); i >= 0 {
		scheme, rest := rawURL[:i+3], rawURL[i+3:]
		at := strings.Index(rest, "@")
		slash := strings.Index(rest, "/")
		// An "@" after the first "/" belongs to the path, not the authority.
		if at < 0 || (slash >= 0 && at > slash) {
			return rawURL
		}
		userinfo, host := rest[:at], rest[at+1:]
		if strings.HasPrefix(scheme, "ssh") {
			if name, _, ok := strings.Cut(userinfo, ":"); ok && name != "" {
				return scheme + name + "@" + host
			}
			return rawURL
		}
		return scheme + host
	}
	// scp-like [user@]host:path.
	at := strings.Index(rawURL, "@")
	if at < 0 {
		return rawURL
	}
	if name, _, ok := strings.Cut(rawURL[:at], ":"); ok {
		if name == "" {
			return rawURL[at+1:]
		}
		return name + "@" + rawURL[at+1:]
	}
	return rawURL
}

// Options is the flag input to Resolve.
type Options struct {
	// Cwd is the directory auto-detection walks up from when neither --git
	// nor --no-git is set.
	Cwd string
	// Git is the --git value and GitSet reports whether the flag was passed,
	// so an explicit empty value can be rejected rather than silently
	// falling back to auto-detection.
	Git    string
	GitSet bool
	// NoGit is the --no-git flag: skip auto-detection entirely.
	NoGit bool
	// GitFlagName is the flag that supplied Git, so an error names what the
	// caller actually typed. Empty means "git"; `amika send` sets "repo" when
	// the value arrived through that alias.
	GitFlagName string
	// NoClean is the local-sandbox --no-clean flag. It only makes sense with a
	// local-path repo, so it constrains which sources are acceptable.
	// Commands that do not offer --no-clean leave it false.
	NoClean bool
}

// Validate reports contradictions between the flags without touching the
// filesystem, so a command can reject a bad invocation before doing any work
// — or before requiring credentials. Resolve applies it too, so a caller that
// skips it still cannot resolve an invalid combination.
func (o Options) Validate() error {
	gitFlag := "--" + FlagGit
	if o.GitFlagName != "" {
		gitFlag = "--" + o.GitFlagName
	}
	if o.GitSet && o.NoGit {
		return fmt.Errorf("%s and --%s are mutually exclusive", gitFlag, FlagNoGit)
	}
	if o.NoClean && o.NoGit {
		return fmt.Errorf("--%s and --%s are mutually exclusive", FlagNoClean, FlagNoGit)
	}
	if o.GitSet {
		v := strings.TrimSpace(o.Git)
		if v == "" {
			return fmt.Errorf("%s requires a non-empty value", gitFlag)
		}
		if o.NoClean && IsNetworkURL(v) {
			return fmt.Errorf("--%s cannot be used with a git URL", FlagNoClean)
		}
	}
	return nil
}

// Resolve decides which git repo (if any) should back a sandbox based on the
// user's flag input and the working directory.
//
//   - Contradictory combinations are rejected by Options.Validate, which this
//     applies first.
//   - When neither --git nor --no-git is set, the function walks up from Cwd
//     to detect a repo; if none is found, the identity is SourceNone.
func Resolve(opts Options) (Identity, error) {
	if err := opts.Validate(); err != nil {
		return Identity{}, err
	}
	if opts.NoGit {
		return Identity{Source: SourceNone}, nil
	}
	if opts.GitSet {
		// Validate already rejected an empty value.
		v := strings.TrimSpace(opts.Git)
		if IsNetworkURL(v) {
			name, err := NameFromURL(v)
			if err != nil {
				return Identity{}, err
			}
			return Identity{Name: name, Source: SourceFlagURL, URL: v}, nil
		}
		// An explicitly named path has to exist. ResolveRoot walks *up*, which
		// is what auto-detection wants but would quietly promote a typo — or
		// GitHub shorthand like "acme/billing", which reads as a repo but is
		// not a URL — into whatever repo happens to enclose the caller.
		if _, statErr := os.Stat(v); statErr != nil {
			return Identity{}, fmt.Errorf("could not find git repo at %q: %w", v, statErr)
		}
		repoRoot, err := ResolveRoot(v)
		if err != nil {
			return Identity{}, fmt.Errorf("could not find git repo at %q: %w", v, err)
		}
		return Identity{Name: filepath.Base(repoRoot), Source: SourceFlagPath, Path: repoRoot}, nil
	}
	repoRoot, err := ResolveRoot(opts.Cwd)
	if err != nil {
		if opts.NoClean {
			return Identity{}, fmt.Errorf("--no-clean requires a git repo, but none was detected from %q", opts.Cwd)
		}
		return Identity{Source: SourceNone}, nil
	}
	return Identity{Name: filepath.Base(repoRoot), Source: SourceAutoDetect, Path: repoRoot}, nil
}

// ResolveRoot walks up from startPath and returns the first directory holding
// a .git entry. A file path is resolved from its containing directory.
func ResolveRoot(startPath string) (string, error) {
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

// ResolveURL turns a --git value into a git URL a remote sandbox can clone:
// a URL passes through, and a local path resolves to that repo's "origin"
// remote.
func ResolveURL(value string) (string, error) {
	if strings.HasPrefix(value, "http://") || strings.HasPrefix(value, "https://") || strings.HasPrefix(value, "git@") {
		return value, nil
	}

	repoRoot, err := ResolveRoot(value)
	if err != nil {
		return "", fmt.Errorf("could not find git repo at %q: %w", value, err)
	}
	remotes, err := ListRemotes(repoRoot)
	if err != nil {
		return "", err
	}
	origin, ok := remotes["origin"]
	if !ok {
		return "", fmt.Errorf("no origin remote found in %q; specify a git HTTP(S) or SSH URL directly with --git <url>, or pass --no-git to create a sandbox without a repo", repoRoot)
	}
	if !IsNetworkURL(origin) {
		return "", fmt.Errorf("origin remote %q is a local path; specify a git HTTP(S) or SSH URL directly with --git <url>, or pass --no-git to create a sandbox without a repo", origin)
	}
	return origin, nil
}

// ListRemotes returns the repo's remotes as a name-to-URL map.
func ListRemotes(repo string) (map[string]string, error) {
	out, err := Output(repo, "remote")
	if err != nil {
		return nil, err
	}
	names := strings.Fields(strings.TrimSpace(out))
	remotes := make(map[string]string, len(names))
	for _, name := range names {
		url, err := Output(repo, "remote", "get-url", name)
		if err != nil {
			return nil, err
		}
		remotes[name] = strings.TrimSpace(url)
	}
	return remotes, nil
}

// IsNetworkURL reports whether a remote URL points at a network host, as
// opposed to a local path (which a sandbox on another machine cannot reach).
// It recognizes http(s)://, ssh://, and the scp-like [user@]host:path form.
func IsNetworkURL(url string) bool {
	switch {
	case strings.HasPrefix(url, "http://"),
		strings.HasPrefix(url, "https://"),
		strings.HasPrefix(url, "ssh://"):
		return true
	case strings.HasPrefix(url, "file://"):
		return false
	}
	// scp-like syntax, which git resolves over ssh. Git's own rule is that a
	// colon with no slash before it makes this an ssh URL, so the user half is
	// optional: "build-host:org/repo.git" is as valid as
	// "git@build-host:org/repo.git".
	colon := strings.Index(url, ":")
	// A one-character host is a Windows drive letter ("C:\repo"), not a host.
	if colon < 2 {
		return false
	}
	if strings.ContainsAny(url[:colon], `/\`) {
		return false
	}
	return url[colon+1:] != ""
}

// NameFromURL extracts the repo name from a git URL.
// Examples:
//
//	https://github.com/foo/bar       -> bar
//	https://github.com/foo/bar.git   -> bar
//	git@github.com:foo/bar.git       -> bar
//	ssh://git@github.com/foo/bar.git -> bar
func NameFromURL(rawURL string) (string, error) {
	s := strings.TrimSpace(rawURL)
	if s == "" {
		return "", fmt.Errorf("empty git URL")
	}
	var pathPart string
	if strings.Contains(s, "://") {
		u, err := url.Parse(s)
		if err != nil {
			return "", fmt.Errorf("parsing git URL %q: %w", rawURL, err)
		}
		pathPart = u.Path
	} else if i := strings.Index(s, ":"); i >= 0 {
		pathPart = s[i+1:]
	} else {
		return "", fmt.Errorf("not a git URL: %q", rawURL)
	}
	pathPart = strings.TrimSuffix(strings.TrimSpace(pathPart), "/")
	if pathPart == "" {
		return "", fmt.Errorf("git URL %q has no repo path", rawURL)
	}
	if i := strings.LastIndex(pathPart, "/"); i >= 0 {
		pathPart = pathPart[i+1:]
	}
	pathPart = strings.TrimSuffix(pathPart, ".git")
	if pathPart == "" {
		return "", fmt.Errorf("could not extract repo name from %q", rawURL)
	}
	if pathPart == "." || pathPart == ".." || strings.ContainsAny(pathPart, "/\\") {
		return "", fmt.Errorf("invalid repo name %q extracted from %q", pathPart, rawURL)
	}
	return pathPart, nil
}

// CurrentBranch returns the branch checked out in the repo containing
// startPath. A detached HEAD is an error, since there is no branch name to
// carry into a sandbox.
func CurrentBranch(startPath string) (string, error) {
	repoRoot, err := ResolveRoot(startPath)
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

// Run runs a git command in repo and discards its output.
func Run(repo string, args ...string) error {
	_, err := Output(repo, args...)
	return err
}

// Output runs a git command in repo and returns its combined output.
func Output(repo string, args ...string) (string, error) {
	cmdArgs := append([]string{"-C", repo}, args...)
	cmd := exec.Command("git", cmdArgs...)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("git %s failed: %s", strings.Join(args, " "), strings.TrimSpace(string(out)))
	}
	return string(out), nil
}

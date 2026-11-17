// Package toolchain installs the dependencies a rig needs onto a machine that
// booted the provider's own image rather than an Amika base image.
//
// The lockfile, sandbox-image/toolchain.lock.json, is generated from
// sandbox-image/versions.env by sandbox-image/toolchain.py and shipped with
// the control plane, which hands it to `amikad install`. It pins the amikad
// release the control plane uploads and every dependency a rig can install.
// A dependency marked default is installed unless excluded; any other only
// when asked for. Each archive names its URL and sha256, and amikad refuses
// a download whose hash differs. npm dependencies name an exact version and
// rely on the registry's integrity checks, as the base image build does.
package toolchain

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"path"
	"regexp"
	"strings"
)

// SchemaVersion is the lockfile format this package reads.
const SchemaVersion = 2

// Kind says how a dependency is fetched.
type Kind string

const (
	// KindArchive is a file downloaded from Artifacts[platform] and checked
	// against its sha256.
	KindArchive Kind = "archive"
	// KindNPM is an npm package installed globally with the lockfile's Node.
	KindNPM Kind = "npm"
)

// Format is the shape of an archive download.
type Format string

const (
	// FormatTarGz is a gzip-compressed tarball.
	FormatTarGz Format = "tar.gz"
	// FormatBinary is a single executable file.
	FormatBinary Format = "binary"
)

// Lockfile is the parsed toolchain.lock.json.
type Lockfile struct {
	Schema int `json:"schema"`
	// Amikad is the release the control plane uploads; `amikad install`
	// never installs it.
	Amikad Dep   `json:"amikad"`
	Deps   []Dep `json:"deps"`
}

// Dep is one pinned dependency.
type Dep struct {
	Name    string `json:"name"`
	Version string `json:"version"`
	// Default dependencies are installed unless excluded.
	Default bool `json:"default,omitempty"`
	Kind    Kind `json:"kind"`
	// Artifacts maps "linux/amd64" and "linux/arm64" to the download, for
	// KindArchive.
	Artifacts map[string]Artifact `json:"artifacts,omitempty"`
	// Package is the npm package name, for KindNPM.
	Package string `json:"package,omitempty"`
	// Bins are the commands a KindNPM dependency puts on PATH.
	Bins []string `json:"bins,omitempty"`
	// LinkDir is where the commands are linked; empty means DefaultBinDir.
	// gh links into /usr/bin, because the control plane's gh auth shim takes
	// /usr/local/bin/gh and runs the next gh on PATH.
	LinkDir string `json:"link_dir,omitempty"`
}

// Artifact is one platform's download of a KindArchive dependency.
type Artifact struct {
	URL    string `json:"url"`
	SHA256 string `json:"sha256"`
	Format Format `json:"format"`
	// Strip drops this many leading path components when extracting.
	Strip int `json:"strip,omitempty"`
	// Bins are the commands this artifact puts on PATH.
	Bins []Bin `json:"bins"`
}

// Bin is one command an archive provides.
type Bin struct {
	// Path is the file inside the extracted directory (or the file's own
	// name for FormatBinary).
	Path string `json:"path"`
	// Name is the command name on PATH; empty means the base name of Path.
	Name string `json:"name,omitempty"`
}

// CommandName is the name the bin gets on PATH.
func (b Bin) CommandName() string {
	if b.Name != "" {
		return b.Name
	}
	return path.Base(b.Path)
}

var (
	depNamePattern = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]{0,63}$`)
	commandPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$`)
	sha256Pattern  = regexp.MustCompile(`^[0-9a-f]{64}$`)
	versionPattern = regexp.MustCompile(`^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$`)
	npmNamePattern = regexp.MustCompile(`^(@[a-z0-9][a-z0-9._-]*/)?[a-z0-9][a-z0-9._-]*$`)
	// allowedLinkDirs are the directories a dependency may link into: both
	// are on every default PATH, sudo's secure_path included.
	allowedLinkDirs = map[string]bool{"/usr/local/bin": true, "/usr/bin": true}
)

// ErrInvalidLockfile marks a lockfile amikad refuses to act on.
var ErrInvalidLockfile = errors.New("invalid toolchain lockfile")

// Parse reads and validates a lockfile. Every field that becomes a path, a
// URL, or a command argument is checked here, before anything is fetched.
func Parse(r io.Reader) (*Lockfile, error) {
	decoder := json.NewDecoder(io.LimitReader(r, 1<<20))
	decoder.DisallowUnknownFields()
	var lock Lockfile
	if err := decoder.Decode(&lock); err != nil {
		return nil, fmt.Errorf("%w: %v", ErrInvalidLockfile, err)
	}
	if lock.Schema != SchemaVersion {
		return nil, fmt.Errorf("%w: schema %d, want %d", ErrInvalidLockfile, lock.Schema, SchemaVersion)
	}
	if err := lock.Amikad.validate(); err != nil || lock.Amikad.Kind != KindArchive {
		return nil, fmt.Errorf("%w: amikad: %v", ErrInvalidLockfile, err)
	}
	names := map[string]bool{OpenSSHServer: true}
	commands := map[string]string{}
	for _, dep := range lock.Deps {
		if err := dep.validate(); err != nil {
			return nil, fmt.Errorf("%w: %s: %v", ErrInvalidLockfile, dep.Name, err)
		}
		if names[dep.Name] {
			return nil, fmt.Errorf("%w: dependency %q listed twice", ErrInvalidLockfile, dep.Name)
		}
		names[dep.Name] = true
		for _, command := range dep.commandNames() {
			if owner, taken := commands[command]; taken && command != "npm" && command != "npx" {
				// npm may replace node's own npm and npx; nothing else may
				// claim another dependency's command.
				return nil, fmt.Errorf("%w: command %q provided by %s and %s", ErrInvalidLockfile, command, owner, dep.Name)
			}
			commands[command] = dep.Name
		}
	}
	return &lock, nil
}

// Dep returns the dependency named name, or false.
func (l *Lockfile) Dep(name string) (Dep, bool) {
	for _, dep := range l.Deps {
		if dep.Name == name {
			return dep, true
		}
	}
	return Dep{}, false
}

func (d Dep) validate() error {
	if !depNamePattern.MatchString(d.Name) {
		return errors.New("bad name")
	}
	if !versionPattern.MatchString(d.Version) {
		return errors.New("bad version")
	}
	if d.LinkDir != "" && !allowedLinkDirs[d.LinkDir] {
		return fmt.Errorf("link_dir %q is not /usr/local/bin or /usr/bin", d.LinkDir)
	}
	switch d.Kind {
	case KindArchive:
		if len(d.Artifacts) == 0 {
			return errors.New("archive dependency has no artifacts")
		}
		for platform, artifact := range d.Artifacts {
			if platform != "linux/amd64" && platform != "linux/arm64" {
				return fmt.Errorf("unknown platform %q", platform)
			}
			if err := artifact.validate(); err != nil {
				return fmt.Errorf("%s: %w", platform, err)
			}
		}
	case KindNPM:
		if !npmNamePattern.MatchString(d.Package) {
			return errors.New("bad npm package")
		}
		if len(d.Bins) == 0 {
			return errors.New("npm dependency has no bins")
		}
		for _, bin := range d.Bins {
			if !commandPattern.MatchString(bin) {
				return fmt.Errorf("bad bin %q", bin)
			}
		}
	default:
		return fmt.Errorf("unknown kind %q", d.Kind)
	}
	return nil
}

func (a Artifact) validate() error {
	if !strings.HasPrefix(a.URL, "https://") {
		return errors.New("url must be https")
	}
	if !sha256Pattern.MatchString(a.SHA256) {
		return errors.New("sha256 must be 64 lowercase hex digits")
	}
	switch a.Format {
	case FormatTarGz:
	case FormatBinary:
		if len(a.Bins) != 1 {
			return errors.New("a binary artifact has exactly one bin")
		}
	default:
		return fmt.Errorf("unknown format %q", a.Format)
	}
	if a.Strip < 0 || a.Strip > 4 {
		return errors.New("strip must be 0 to 4")
	}
	if len(a.Bins) == 0 {
		return errors.New("no bins")
	}
	for _, bin := range a.Bins {
		if _, err := cleanRelative(bin.Path); err != nil {
			return fmt.Errorf("bin %q: %w", bin.Path, err)
		}
		if !commandPattern.MatchString(bin.CommandName()) {
			return fmt.Errorf("bad command name %q", bin.CommandName())
		}
	}
	return nil
}

func (d Dep) commandNames() []string {
	if d.Kind == KindNPM {
		return d.Bins
	}
	seen := map[string]bool{}
	var names []string
	for _, artifact := range d.Artifacts {
		for _, bin := range artifact.Bins {
			if !seen[bin.CommandName()] {
				seen[bin.CommandName()] = true
				names = append(names, bin.CommandName())
			}
		}
	}
	return names
}

// cleanRelative returns p cleaned, refusing absolute paths and any path that
// leaves its root.
func cleanRelative(p string) (string, error) {
	if p == "" || strings.HasPrefix(p, "/") {
		return "", errors.New("must be a relative path")
	}
	cleaned := path.Clean(p)
	if cleaned == "." || cleaned == ".." || strings.HasPrefix(cleaned, "../") {
		return "", errors.New("must stay inside the dependency's directory")
	}
	return cleaned, nil
}

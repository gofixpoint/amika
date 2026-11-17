package toolchain

import (
	"context"
	"crypto/sha256"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"
)

// Default install locations. Dependencies live under DefaultPrefix and
// their commands are linked into DefaultBinDir (or a dependency's LinkDir),
// which is on every default PATH, sudo's secure_path included.
const (
	DefaultPrefix = "/opt/amika"
	DefaultBinDir = "/usr/local/bin"
)

// markerFile records, inside a tool directory, the sha256 it was built from.
const markerFile = ".amika-sha256"

// downloadConcurrency bounds parallel downloads.
const downloadConcurrency = 4

// Timing is one dependency's line in the install report.
type Timing struct {
	Dep     string `json:"dep"`
	Version string `json:"version,omitempty"`
	// Status is "installed", or "present" when nothing had to change.
	Status     string `json:"status"`
	DownloadMS int64  `json:"download_ms,omitempty"`
	UnpackMS   int64  `json:"unpack_ms,omitempty"`
	TotalMS    int64  `json:"total_ms"`
}

// Options configures an install.
type Options struct {
	// Prefix and BinDir default to DefaultPrefix and DefaultBinDir. A
	// dependency's LinkDir, when set, replaces BinDir under BinRoot.
	Prefix string
	BinDir string
	// BinRoot prefixes a dependency's LinkDir; "" in production, a temporary
	// directory in tests.
	BinRoot string
	// Platform defaults to the running OS/architecture ("linux/amd64").
	Platform string
	// Path is searched for the image's own commands (Dep.PreferImage);
	// defaults to $PATH.
	Path string
	// HTTPClient defaults to a client with a per-download timeout.
	HTTPClient *http.Client
	// RunNPM runs npm with args and env; tests replace it. The default runs
	// the lockfile Node's own npm.
	RunNPM func(ctx context.Context, nodeDir string, args []string, log io.Writer) error
	// EnsureOpenSSHServer installs sshd from the package manager when it is
	// missing and reports whether it did. Nil skips OpenSSH server.
	EnsureOpenSSHServer func(ctx context.Context) (installed bool, err error)
	// Report receives one Timing per dependency.
	Report func(Timing)
	// Log receives progress text.
	Log io.Writer
}

// Install installs the selection: OpenSSH server when asked for and
// missing, then every lockfile dependency not already at its pinned version,
// linking its commands. It is idempotent: a second run downloads nothing and
// only repairs links. It never replaces a file it did not create.
func Install(ctx context.Context, selection Selection, options Options) error {
	options = withDefaults(options)
	if selection.OpenSSHServer && options.EnsureOpenSSHServer != nil {
		started := time.Now()
		installed, err := options.EnsureOpenSSHServer(ctx)
		if err != nil {
			return fmt.Errorf("%s: %w", OpenSSHServer, err)
		}
		options.Report(Timing{Dep: OpenSSHServer, Status: status(installed), TotalMS: since(started)})
	}
	var archives, packages []Dep
	var node Dep
	for _, dep := range selection.Deps {
		if dep.PreferImage {
			if paths := imageCommands(dep, options); paths != nil {
				fmt.Fprintf(options.Log, "keeping the image's %s (%s)\n", dep.Name, strings.Join(paths, ", "))
				options.Report(Timing{Dep: dep.Name, Status: "present"})
				continue
			}
		}
		switch dep.Kind {
		case KindArchive:
			archives = append(archives, dep)
		case KindNPM:
			packages = append(packages, dep)
		}
		if dep.Name == nodeDepName {
			node = dep
		}
	}
	if err := os.MkdirAll(filepath.Join(options.Prefix, "tools"), 0o755); err != nil {
		return err
	}
	if err := installArchives(ctx, archives, options); err != nil {
		return err
	}
	if len(packages) == 0 {
		return nil
	}
	if node.Name == "" {
		return errors.New("npm dependencies need the node dependency in the selection")
	}
	return installPackages(ctx, node, packages, options)
}

func withDefaults(options Options) Options {
	if options.Prefix == "" {
		options.Prefix = DefaultPrefix
	}
	if options.BinDir == "" {
		options.BinDir = DefaultBinDir
	}
	if options.Platform == "" {
		options.Platform = runtime.GOOS + "/" + runtime.GOARCH
	}
	if options.Path == "" {
		options.Path = os.Getenv("PATH")
	}
	if options.HTTPClient == nil {
		options.HTTPClient = &http.Client{Timeout: 10 * time.Minute}
	}
	if options.RunNPM == nil {
		options.RunNPM = runNPM
	}
	if options.Log == nil {
		options.Log = io.Discard
	}
	if options.Report == nil {
		options.Report = func(Timing) {}
	}
	return options
}

func status(installed bool) string {
	if installed {
		return "installed"
	}
	return "present"
}

func since(started time.Time) int64 { return time.Since(started).Milliseconds() }

// installArchives downloads the missing archives in parallel, then links
// every archive's commands.
func installArchives(ctx context.Context, deps []Dep, options Options) error {
	var (
		wait  sync.WaitGroup
		mutex sync.Mutex
		errs  []error
	)
	// Every artifact is checked before any download starts, so a refusal
	// never leaves downloads running behind it.
	artifacts := make([]Artifact, len(deps))
	for i, dep := range deps {
		artifact, ok := dep.Artifacts[options.Platform]
		if !ok {
			return fmt.Errorf("%s has no download for %s", dep.Name, options.Platform)
		}
		artifacts[i] = artifact
	}
	slots := make(chan struct{}, downloadConcurrency)
	for i, dep := range deps {
		artifact := artifacts[i]
		wait.Add(1)
		go func() {
			defer wait.Done()
			slots <- struct{}{}
			defer func() { <-slots }()
			if err := installArchive(ctx, dep, artifact, options, &mutex); err != nil {
				mutex.Lock()
				errs = append(errs, fmt.Errorf("%s %s: %w", dep.Name, dep.Version, err))
				mutex.Unlock()
			}
		}()
	}
	wait.Wait()
	return errors.Join(errs...)
}

func installArchive(ctx context.Context, dep Dep, artifact Artifact, options Options, report *sync.Mutex) error {
	started := time.Now()
	dest := depDir(options.Prefix, dep)
	timing := Timing{Dep: dep.Name, Version: dep.Version, Status: "present"}
	if installedSHA(dest) != artifact.SHA256 {
		download, unpack, err := fetchAndUnpack(ctx, dep, artifact, dest, options)
		if err != nil {
			return err
		}
		timing.Status = "installed"
		timing.DownloadMS = download.Milliseconds()
		timing.UnpackMS = unpack.Milliseconds()
		fmt.Fprintf(options.Log, "installed %s %s in %s\n", dep.Name, dep.Version, time.Since(started).Round(100*time.Millisecond))
	}
	for _, bin := range artifact.Bins {
		cleaned, _ := cleanRelative(bin.Path)
		if err := linkCommand(options, linkDir(options, dep), bin.CommandName(), filepath.Join(dest, filepath.FromSlash(cleaned))); err != nil {
			return err
		}
	}
	timing.TotalMS = since(started)
	report.Lock()
	options.Report(timing)
	report.Unlock()
	return nil
}

// linkDir is where dep's commands are linked.
func linkDir(options Options, dep Dep) string {
	if dep.LinkDir == "" {
		return options.BinDir
	}
	return filepath.Join(options.BinRoot, filepath.FromSlash(dep.LinkDir))
}

func depDir(prefix string, dep Dep) string {
	return filepath.Join(prefix, "tools", dep.Name+"-"+dep.Version)
}

func installedSHA(dest string) string {
	data, err := os.ReadFile(filepath.Join(dest, markerFile))
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(data))
}

// fetchAndUnpack downloads the artifact, checks its sha256, and unpacks it
// into a staging directory that replaces dest only once complete, so an
// interrupted install never leaves a half-written tool behind its marker.
func fetchAndUnpack(ctx context.Context, dep Dep, artifact Artifact, dest string, options Options) (downloadTime, unpackTime time.Duration, err error) {
	started := time.Now()
	toolsDir := filepath.Dir(dest)
	download, err := os.CreateTemp(toolsDir, ".download-"+dep.Name+"-*")
	if err != nil {
		return 0, 0, err
	}
	defer os.Remove(download.Name())
	sum, err := fetch(ctx, options.HTTPClient, artifact.URL, download)
	if closeErr := download.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return 0, 0, err
	}
	if sum != artifact.SHA256 {
		return 0, 0, fmt.Errorf("sha256 mismatch for %s: got %s, want %s", artifact.URL, sum, artifact.SHA256)
	}
	downloadTime = time.Since(started)
	unpacked := time.Now()
	err = unpack(dep, artifact, download.Name(), dest, toolsDir)
	return downloadTime, time.Since(unpacked), err
}

// unpack extracts the verified download into a staging directory that
// replaces dest only once complete.
func unpack(dep Dep, artifact Artifact, downloadPath, dest, toolsDir string) error {
	staging, err := os.MkdirTemp(toolsDir, ".staging-"+dep.Name+"-*")
	if err != nil {
		return err
	}
	defer os.RemoveAll(staging)
	if err := os.Chmod(staging, 0o755); err != nil {
		return err
	}
	switch artifact.Format {
	case FormatTarGz:
		if err := extractTarGz(downloadPath, staging, artifact.Strip); err != nil {
			return err
		}
	case FormatBinary:
		cleaned, _ := cleanRelative(artifact.Bins[0].Path)
		target := filepath.Join(staging, filepath.FromSlash(cleaned))
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			return err
		}
		if err := os.Rename(downloadPath, target); err != nil {
			return err
		}
		if err := os.Chmod(target, 0o755); err != nil {
			return err
		}
	}
	for _, bin := range artifact.Bins {
		cleaned, _ := cleanRelative(bin.Path)
		if _, err := os.Stat(filepath.Join(staging, filepath.FromSlash(cleaned))); err != nil {
			return fmt.Errorf("archive has no %s: %w", bin.Path, err)
		}
	}
	if err := os.WriteFile(filepath.Join(staging, markerFile), []byte(artifact.SHA256+"\n"), 0o644); err != nil {
		return err
	}
	if err := os.RemoveAll(dest); err != nil {
		return err
	}
	return os.Rename(staging, dest)
}

// fetch streams url into w and returns the hex sha256 of what it wrote. It
// retries network errors and 5xx answers a few times.
func fetch(ctx context.Context, client *http.Client, url string, w *os.File) (string, error) {
	var lastErr error
	for attempt := range 3 {
		if attempt > 0 {
			select {
			case <-ctx.Done():
				return "", ctx.Err()
			case <-time.After(time.Duration(attempt) * time.Second):
			}
			if err := w.Truncate(0); err != nil {
				return "", err
			}
			if _, err := w.Seek(0, io.SeekStart); err != nil {
				return "", err
			}
		}
		sum, retry, err := fetchOnce(ctx, client, url, w)
		if err == nil {
			return sum, nil
		}
		lastErr = err
		if !retry {
			break
		}
	}
	return "", lastErr
}

func fetchOnce(ctx context.Context, client *http.Client, url string, w io.Writer) (string, bool, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return "", false, err
	}
	response, err := client.Do(request)
	if err != nil {
		var unknownAuthority x509.UnknownAuthorityError
		if errors.As(err, &unknownAuthority) {
			return "", false, fmt.Errorf("download %s: %w (if the image has no CA certificates, install the ca-certificates package)", url, err)
		}
		return "", ctx.Err() == nil, fmt.Errorf("download %s: %w", url, err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return "", response.StatusCode >= 500, fmt.Errorf("download %s: HTTP %d", url, response.StatusCode)
	}
	hash := sha256.New()
	if _, err := io.Copy(io.MultiWriter(w, hash), response.Body); err != nil {
		return "", ctx.Err() == nil, fmt.Errorf("download %s: %w", url, err)
	}
	return hex.EncodeToString(hash.Sum(nil)), false, nil
}

// linkCommand points binDir/name at target, replacing an earlier link of
// amikad's atomically. Any other file there belongs to the image, and stays.
func linkCommand(options Options, binDir, name, target string) error {
	if err := os.MkdirAll(binDir, 0o755); err != nil {
		return err
	}
	link := filepath.Join(binDir, name)
	if current, err := os.Readlink(link); err == nil && current == target {
		return nil
	}
	if _, err := os.Lstat(link); err == nil && !linkedByAmikad(link, options.Prefix) {
		fmt.Fprintf(options.Log, "keeping %s, which amikad did not create\n", link)
		return nil
	}
	temporary := filepath.Join(binDir, ".amika-link-"+name)
	_ = os.Remove(temporary)
	if err := os.Symlink(target, temporary); err != nil {
		return err
	}
	return os.Rename(temporary, link)
}

// imageCommands returns where the image itself provides each of dep's
// commands on options.Path, outside options.BinDir and amikad's own links,
// or nil when it lacks one.
func imageCommands(dep Dep, options Options) []string {
	var names []string
	switch dep.Kind {
	case KindArchive:
		for _, bin := range dep.Artifacts[options.Platform].Bins {
			names = append(names, bin.CommandName())
		}
	case KindNPM:
		names = dep.Bins
	}
	if len(names) == 0 {
		return nil
	}
	var found []string
	for _, name := range names {
		path := imageCommand(name, options)
		if path == "" {
			return nil
		}
		found = append(found, path)
	}
	return found
}

func imageCommand(name string, options Options) string {
	for _, dir := range filepath.SplitList(options.Path) {
		if dir == "" || filepath.Clean(dir) == filepath.Clean(options.BinDir) {
			continue
		}
		candidate := filepath.Join(dir, name)
		info, err := os.Stat(candidate)
		if err != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0o111 == 0 {
			continue
		}
		if linkedByAmikad(candidate, options.Prefix) {
			continue
		}
		return candidate
	}
	return ""
}

// linkedByAmikad reports whether path is a symlink into prefix, which only
// amikad makes.
func linkedByAmikad(path, prefix string) bool {
	target, err := os.Readlink(path)
	if err != nil {
		return false
	}
	rel, err := filepath.Rel(filepath.Clean(prefix), filepath.Clean(target))
	return err == nil && rel != "." && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))
}

// installPackages installs the KindNPM dependencies whose pinned version is
// not already present, then links their commands. Dependencies that ask for
// the same npm flags share one npm run, so one dependency's flags never
// apply to another.
func installPackages(ctx context.Context, node Dep, deps []Dep, options Options) error {
	groups := map[string][]Dep{}
	var order []string
	for _, dep := range deps {
		key := strings.Join(npmFlags(dep), " ")
		if _, seen := groups[key]; !seen {
			order = append(order, key)
		}
		groups[key] = append(groups[key], dep)
	}
	for _, key := range order {
		if err := installPackageRun(ctx, node, groups[key], options); err != nil {
			return err
		}
	}
	return nil
}

// npmFlags are the npm install flags dep asks for.
func npmFlags(dep Dep) []string {
	var flags []string
	if dep.EngineStrict {
		flags = append(flags, "--engine-strict")
	}
	if dep.IgnoreScripts {
		flags = append(flags, "--ignore-scripts")
	}
	return flags
}

// installPackageRun installs deps, which share their npm flags, in one npm
// run. Each installed dependency reports the run's time.
func installPackageRun(ctx context.Context, node Dep, deps []Dep, options Options) error {
	npmPrefix := filepath.Join(options.Prefix, "npm")
	var specs []string
	missing := map[string]bool{}
	for _, dep := range deps {
		if installedNPMVersion(npmPrefix, dep.Package) != dep.Version {
			specs = append(specs, dep.Package+"@"+dep.Version)
			missing[dep.Name] = true
		}
	}
	started := time.Now()
	if len(specs) > 0 {
		args := []string{
			"install", "--global", "--prefix", npmPrefix,
			"--no-fund", "--no-audit", "--loglevel=error",
		}
		args = append(args, npmFlags(deps[0])...)
		args = append(args, specs...)
		if err := options.RunNPM(ctx, depDir(options.Prefix, node), args, options.Log); err != nil {
			return fmt.Errorf("npm install %s: %w", strings.Join(specs, " "), err)
		}
		fmt.Fprintf(options.Log, "installed %s in %s\n", strings.Join(specs, " "), time.Since(started).Round(100*time.Millisecond))
	}
	elapsed := since(started)
	for _, dep := range deps {
		if got := installedNPMVersion(npmPrefix, dep.Package); got != dep.Version {
			return fmt.Errorf("%s: npm installed %q, want %s", dep.Name, got, dep.Version)
		}
		for _, bin := range dep.Bins {
			if err := linkCommand(options, linkDir(options, dep), bin, filepath.Join(npmPrefix, "bin", bin)); err != nil {
				return err
			}
		}
		timing := Timing{Dep: dep.Name, Version: dep.Version, Status: status(missing[dep.Name])}
		if missing[dep.Name] {
			timing.TotalMS = elapsed
		}
		options.Report(timing)
	}
	return nil
}

// installedNPMVersion is the version of a globally installed package under
// prefix, or "" when it is absent.
func installedNPMVersion(prefix, pkg string) string {
	data, err := os.ReadFile(filepath.Join(prefix, "lib", "node_modules", filepath.FromSlash(pkg), "package.json"))
	if err != nil {
		return ""
	}
	var manifest struct {
		Version string `json:"version"`
	}
	if json.Unmarshal(data, &manifest) != nil {
		return ""
	}
	return manifest.Version
}

// runNPM runs the lockfile Node's npm with that Node first on PATH, so
// install scripts run with the pinned Node, not one the image ships.
func runNPM(ctx context.Context, nodeDir string, args []string, log io.Writer) error {
	command := exec.CommandContext(ctx, filepath.Join(nodeDir, "bin", "npm"), args...)
	command.Env = append(os.Environ(),
		"PATH="+filepath.Join(nodeDir, "bin")+":"+os.Getenv("PATH"),
		"npm_config_update_notifier=false",
	)
	command.Stdout = log
	command.Stderr = log
	return command.Run()
}

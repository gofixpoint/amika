package toolchain

import (
	"archive/tar"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const testSHA = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

const validLock = `{
  "schema": 2,
  "amikad": {"name": "amikad", "version": "0.4.0", "kind": "archive",
    "artifacts": {"linux/amd64": {"url": "https://example.com/amikad.tgz",
      "sha256": "` + testSHA + `", "format": "tar.gz", "strip": 1, "bins": [{"path": "amikad"}]}}},
  "deps": [
    {"name": "gh", "version": "2.1.0", "default": true, "kind": "archive", "link_dir": "/usr/bin",
     "artifacts": {"linux/amd64": {"url": "https://example.com/gh.tgz",
       "sha256": "` + testSHA + `", "format": "tar.gz", "strip": 1, "bins": [{"path": "bin/gh"}]}}},
    {"name": "node", "version": "24.0.0", "kind": "archive",
     "artifacts": {"linux/amd64": {"url": "https://example.com/node.tgz",
       "sha256": "` + testSHA + `", "format": "tar.gz", "strip": 1, "bins": [{"path": "bin/node"}]}}},
    {"name": "opencode", "version": "1.0.0", "kind": "npm", "package": "opencode-ai", "bins": ["opencode"]}
  ]
}`

func parseValid(t *testing.T) *Lockfile {
	t.Helper()
	lock, err := Parse(strings.NewReader(validLock))
	if err != nil {
		t.Fatal(err)
	}
	return lock
}

func TestParseAcceptsAValidLockfile(t *testing.T) {
	lock := parseValid(t)
	if dep, ok := lock.Dep("gh"); !ok || !dep.Default || dep.LinkDir != "/usr/bin" {
		t.Fatalf("gh = %+v", dep)
	}
	if lock.Amikad.Version != "0.4.0" {
		t.Fatalf("amikad = %+v", lock.Amikad)
	}
}

func TestParseRefusesUnsafeLockfiles(t *testing.T) {
	cases := map[string]string{
		"http url":               strings.Replace(validLock, "https://example.com/gh", "http://example.com/gh", 1),
		"short sha":              strings.Replace(validLock, testSHA, "abc", 1),
		"path traversal":         strings.Replace(validLock, `"bin/gh"`, `"../../etc/passwd"`, 1),
		"absolute path":          strings.Replace(validLock, `"bin/gh"`, `"/usr/bin/gh"`, 1),
		"link dir":               strings.Replace(validLock, `"link_dir": "/usr/bin"`, `"link_dir": "/etc"`, 1),
		"npm flag on an archive": strings.Replace(validLock, `"link_dir": "/usr/bin"`, `"link_dir": "/usr/bin", "ignore_scripts": true`, 1),
		"bad package":            strings.Replace(validLock, `"package": "opencode-ai"`, `"package": "x; rm -rf /"`, 1),
		"old schema":             strings.Replace(validLock, `"schema": 2`, `"schema": 1`, 1),
		"unknown field":          strings.Replace(validLock, `"schema": 2`, `"schema": 2, "extra": true`, 1),
		"bad command":            strings.Replace(validLock, `["opencode"]`, `["../opencode"]`, 1),
		"reserved name":          strings.Replace(validLock, `"name": "opencode"`, `"name": "openssh-server"`, 1),
		"npm tag":                strings.Replace(validLock, `"version": "1.0.0", "kind": "npm"`, `"version": "latest", "kind": "npm"`, 1),
		"shared directory": strings.Replace(strings.Replace(validLock, `"version": "2.1.0"`, `"version": "2.1.0-rc"`, 1),
			`"name": "node", "version": "24.0.0"`, `"name": "gh-2.1.0", "version": "rc"`, 1),
		"trailing data":  validLock + `{"schema": 2}`,
		"bad npm_before": strings.Replace(validLock, `"schema": 2`, `"schema": 2, "npm_before": "yesterday"`, 1),
	}
	for name, input := range cases {
		t.Run(name, func(t *testing.T) {
			if _, err := Parse(strings.NewReader(input)); !errors.Is(err, ErrInvalidLockfile) {
				t.Fatalf("err = %v, want ErrInvalidLockfile", err)
			}
		})
	}
}

func TestSelectDefaultsAddsAndExclusions(t *testing.T) {
	lock := parseValid(t)
	names := func(selection Selection) string {
		var out []string
		if selection.OpenSSHServer {
			out = append(out, OpenSSHServer)
		}
		for _, dep := range selection.Deps {
			out = append(out, dep.Name)
		}
		return strings.Join(out, ",")
	}
	cases := []struct {
		add, without []string
		want         string
	}{
		{want: "openssh-server,gh"},
		{without: []string{"gh"}, want: "openssh-server"},
		{without: []string{"gh", "openssh-server"}, want: ""},
		// An npm dependency brings Node.
		{add: []string{"opencode"}, want: "openssh-server,gh,node,opencode"},
		{add: []string{"node"}, without: []string{"gh"}, want: "openssh-server,node"},
	}
	for _, c := range cases {
		selection, err := Select(lock, c.add, c.without)
		if err != nil {
			t.Fatalf("Select(%v, %v): %v", c.add, c.without, err)
		}
		if got := names(selection); got != c.want {
			t.Errorf("Select(%v, %v) = %s, want %s", c.add, c.without, got, c.want)
		}
	}
}

func TestSelectRefusesBadRequests(t *testing.T) {
	lock := parseValid(t)
	for name, c := range map[string]struct{ add, without []string }{
		"unknown":          {add: []string{"vim"}},
		"added and kept":   {add: []string{"node"}, without: []string{"node"}},
		"npm without node": {add: []string{"opencode"}, without: []string{"node"}},
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := Select(lock, c.add, c.without); err == nil {
				t.Fatal("Select accepted it")
			}
		})
	}
}

func TestExtractRefusesEntriesOutsideTheToolDirectory(t *testing.T) {
	cases := map[string]tarEntry{
		"dot dot":         {name: "x/../../escape", body: "x"},
		"absolute":        {name: "/etc/escape", body: "x"},
		"symlink escapes": {name: "x/link", link: "../../outside", typeflag: tar.TypeSymlink},
		"absolute link":   {name: "x/link", link: "/etc/passwd", typeflag: tar.TypeSymlink},
	}
	for name, entry := range cases {
		t.Run(name, func(t *testing.T) {
			dir := t.TempDir()
			archive := filepath.Join(dir, "a.tgz")
			if err := os.WriteFile(archive, makeTarGz(t, entry), 0o644); err != nil {
				t.Fatal(err)
			}
			if err := extractTarGz(archive, filepath.Join(dir, "out"), 0); err == nil {
				t.Fatal("extract accepted an entry that leaves the tool directory")
			}
		})
	}
}

func TestExtractRefusesEscapesThroughExtractedSymlinks(t *testing.T) {
	cases := map[string][]tarEntry{
		// root/up points at the tool directory itself, which the text check
		// allows; a file written under it lands in the tool directory too.
		"file under a link": {
			{name: "root/up", link: ".", typeflag: tar.TypeSymlink},
			{name: "root/up/file", body: "x"},
		},
		// Each link's text stays inside, but together they lead out: x/b
		// resolves to the root, so x/b/c -> .. resolves above it.
		"chained links": {
			{name: "root/x/b", link: "..", typeflag: tar.TypeSymlink},
			{name: "root/x/l", link: "b/../..", typeflag: tar.TypeSymlink},
		},
		"hard link through a link": {
			{name: "root/dir/file", body: "x"},
			{name: "root/up", link: "dir", typeflag: tar.TypeSymlink},
			{name: "root/copy", link: "root/up/file", typeflag: tar.TypeLink},
		},
	}
	for name, entries := range cases {
		t.Run(name, func(t *testing.T) {
			dir := t.TempDir()
			archive := filepath.Join(dir, "a.tgz")
			if err := os.WriteFile(archive, makeTarGz(t, entries...), 0o644); err != nil {
				t.Fatal(err)
			}
			if err := extractTarGz(archive, filepath.Join(dir, "out"), 1); err == nil {
				t.Fatal("extract accepted an entry that goes through or out of a symlink")
			}
		})
	}
}

func TestExtractTreatsDotSlashNamesAsTheSameEntry(t *testing.T) {
	// ".//a" must be the same entry as "a": a link at one must stop writes
	// under the other, and its target must be checked from where it lands.
	dir := t.TempDir()
	archive := filepath.Join(dir, "a.tgz")
	data := makeTarGz(t,
		tarEntry{name: ".//a", link: "../../../../etc", typeflag: tar.TypeSymlink},
		tarEntry{name: "a/evil", body: "x"},
	)
	if err := os.WriteFile(archive, data, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := extractTarGz(archive, filepath.Join(dir, "out", "tool"), 0); err == nil {
		t.Fatal("extract accepted a link that leaves the tool directory")
	}
	if _, err := os.Stat(filepath.Join(dir, "etc", "evil")); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("extract wrote outside the tool directory")
	}
}

func TestExtractKeepsInternalSymlinks(t *testing.T) {
	dir := t.TempDir()
	archive := filepath.Join(dir, "a.tgz")
	data := makeTarGz(t,
		tarEntry{name: "node/lib/npm-cli.js", body: "js"},
		tarEntry{name: "node/bin/npm", link: "../lib/npm-cli.js", typeflag: tar.TypeSymlink},
	)
	if err := os.WriteFile(archive, data, 0o644); err != nil {
		t.Fatal(err)
	}
	out := filepath.Join(dir, "out")
	if err := extractTarGz(archive, out, 1); err != nil {
		t.Fatal(err)
	}
	body, err := os.ReadFile(filepath.Join(out, "bin", "npm"))
	if err != nil || string(body) != "js" {
		t.Fatalf("npm link = %q, %v", body, err)
	}
}

// The generated lockfile must parse, so sandbox-image/toolchain.py and
// amikad cannot drift apart, and its defaults must be what the control
// plane expects: OpenSSH server and gh, nothing heavier.
func TestRepositoryLockfileParses(t *testing.T) {
	file, err := os.Open("../../../../sandbox-image/toolchain.lock.json")
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	lock, err := Parse(file)
	if err != nil {
		t.Fatal(err)
	}
	selection, err := Select(lock, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if !selection.OpenSSHServer || len(selection.Deps) != 1 || selection.Deps[0].Name != "gh" {
		t.Fatalf("defaults = %+v", selection)
	}
	if _, err := Select(lock, []string{"pi-web", "opencode", "claude-code", "codex"}, nil); err != nil {
		t.Fatal(err)
	}
}

package toolchain

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
)

type tarEntry struct {
	name, body, link string
	mode             int64
	typeflag         byte
}

func makeTarGz(t *testing.T, entries ...tarEntry) []byte {
	t.Helper()
	var buffer bytes.Buffer
	gz := gzip.NewWriter(&buffer)
	tw := tar.NewWriter(gz)
	for _, entry := range entries {
		header := &tar.Header{Name: entry.name, Mode: entry.mode, Typeflag: entry.typeflag, Linkname: entry.link}
		if header.Typeflag == 0 {
			header.Typeflag = tar.TypeReg
		}
		if header.Mode == 0 {
			header.Mode = 0o755
		}
		if header.Typeflag == tar.TypeReg {
			header.Size = int64(len(entry.body))
		}
		if err := tw.WriteHeader(header); err != nil {
			t.Fatal(err)
		}
		if header.Typeflag == tar.TypeReg {
			if _, err := tw.Write([]byte(entry.body)); err != nil {
				t.Fatal(err)
			}
		}
	}
	if err := tw.Close(); err != nil {
		t.Fatal(err)
	}
	if err := gz.Close(); err != nil {
		t.Fatal(err)
	}
	return buffer.Bytes()
}

func sha(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

// serve answers each path with its bytes and counts requests.
func serve(t *testing.T, files map[string][]byte) (*httptest.Server, *atomic.Int32) {
	t.Helper()
	var hits atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		data, ok := files[r.URL.Path]
		if !ok {
			http.NotFound(w, r)
			return
		}
		_, _ = w.Write(data)
	}))
	t.Cleanup(server.Close)
	return server, &hits
}

func testOptions(t *testing.T) Options {
	t.Helper()
	root := t.TempDir()
	return Options{
		Prefix:   filepath.Join(root, "opt"),
		BinDir:   filepath.Join(root, "bin"),
		BinRoot:  filepath.Join(root, "root"),
		Platform: "linux/amd64",
	}
}

func archiveDep(name, url, sum string, strip int, bins ...Bin) Dep {
	return Dep{
		Name: name, Version: "1.0.0", Kind: KindArchive,
		Artifacts: map[string]Artifact{"linux/amd64": {URL: url, SHA256: sum, Format: FormatTarGz, Strip: strip, Bins: bins}},
	}
}

func TestInstallArchiveLinksCommandsAndIsIdempotent(t *testing.T) {
	archive := makeTarGz(t,
		tarEntry{name: "gh_1.0.0/bin/gh", body: "#!/bin/sh\necho gh\n"},
		tarEntry{name: "gh_1.0.0/LICENSE", body: "mit", mode: 0o644},
	)
	server, hits := serve(t, map[string][]byte{"/gh.tgz": archive})
	gh := archiveDep("gh", server.URL+"/gh.tgz", sha(archive), 1, Bin{Path: "bin/gh"})
	gh.LinkDir = "/usr/bin"
	options := testOptions(t)
	var timings []Timing
	options.Report = func(timing Timing) { timings = append(timings, timing) }

	for range 2 {
		if err := Install(context.Background(), Selection{Deps: []Dep{gh}}, options); err != nil {
			t.Fatal(err)
		}
	}
	if hits.Load() != 1 {
		t.Fatalf("downloads = %d, want 1 (second run must reuse the install)", hits.Load())
	}
	// gh links beside the system's commands, behind the gh auth shim in
	// /usr/local/bin.
	target, err := os.Readlink(filepath.Join(options.BinRoot, "usr", "bin", "gh"))
	if err != nil {
		t.Fatal(err)
	}
	if want := filepath.Join(options.Prefix, "tools", "gh-1.0.0", "bin", "gh"); target != want {
		t.Fatalf("link = %s, want %s", target, want)
	}
	if len(timings) != 2 || timings[0].Status != "installed" || timings[1].Status != "present" {
		t.Fatalf("timings = %+v", timings)
	}
}

// ghWithShim is a prefer_image gh served by a test server, the way the
// lockfile pins it.
func ghWithShim(t *testing.T) (Dep, *atomic.Int32) {
	t.Helper()
	archive := makeTarGz(t, tarEntry{name: "gh_1.0.0/bin/gh", body: "#!/bin/sh\necho gh\n"})
	server, hits := serve(t, map[string][]byte{"/gh.tgz": archive})
	gh := archiveDep("gh", server.URL+"/gh.tgz", sha(archive), 1, Bin{Path: "bin/gh"})
	gh.LinkDir = "/usr/bin"
	gh.PreferImage = true
	return gh, hits
}

func writeExecutable(t *testing.T, path, body string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(body), 0o755); err != nil {
		t.Fatal(err)
	}
}

func TestInstallKeepsTheImagesGh(t *testing.T) {
	gh, hits := ghWithShim(t)
	options := testOptions(t)
	imageBin := filepath.Join(t.TempDir(), "usr-bin")
	writeExecutable(t, filepath.Join(imageBin, "gh"), "image gh")
	options.Path = options.BinDir + string(os.PathListSeparator) + imageBin
	var timings []Timing
	options.Report = func(timing Timing) { timings = append(timings, timing) }

	if err := Install(context.Background(), Selection{Deps: []Dep{gh}}, options); err != nil {
		t.Fatal(err)
	}
	if hits.Load() != 0 {
		t.Fatalf("downloads = %d, want none: the image has gh", hits.Load())
	}
	if len(timings) != 1 || timings[0].Status != "present" {
		t.Fatalf("timings = %+v, want gh present", timings)
	}
	if _, err := os.Lstat(filepath.Join(options.BinRoot, "usr", "bin", "gh")); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("install linked a gh although the image has one")
	}
}

func TestInstallIgnoresAGhInTheShimsDirectory(t *testing.T) {
	gh, hits := ghWithShim(t)
	options := testOptions(t)
	// The shim's directory: whatever is here, the shim replaces.
	writeExecutable(t, filepath.Join(options.BinDir, "gh"), "image gh")
	options.Path = options.BinDir
	var log strings.Builder
	options.Log = &log

	for range 2 {
		if err := Install(context.Background(), Selection{Deps: []Dep{gh}}, options); err != nil {
			t.Fatal(err)
		}
	}
	if hits.Load() != 1 {
		t.Fatalf("downloads = %d, want the pinned gh once", hits.Load())
	}
	if _, err := os.Readlink(filepath.Join(options.BinRoot, "usr", "bin", "gh")); err != nil {
		t.Fatalf("pinned gh not linked into /usr/bin: %v", err)
	}
	// The second run must not take amikad's own link for the image's gh.
	options.Path = filepath.Join(options.BinRoot, "usr", "bin")
	if err := Install(context.Background(), Selection{Deps: []Dep{gh}}, options); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(log.String(), "keeping the image's") {
		t.Fatalf("amikad's own gh link was taken for the image's: %s", log.String())
	}
}

func TestInstallKeepsAFileItDidNotCreate(t *testing.T) {
	archive := makeTarGz(t, tarEntry{name: "tool_1.0.0/bin/tool", body: "pinned"})
	server, _ := serve(t, map[string][]byte{"/tool.tgz": archive})
	tool := archiveDep("tool", server.URL+"/tool.tgz", sha(archive), 1, Bin{Path: "bin/tool"})
	options := testOptions(t)
	image := filepath.Join(options.BinDir, "tool")
	writeExecutable(t, image, "image tool")

	if err := Install(context.Background(), Selection{Deps: []Dep{tool}}, options); err != nil {
		t.Fatal(err)
	}
	if data, _ := os.ReadFile(image); string(data) != "image tool" {
		t.Fatalf("%s = %q, want the image's file kept", image, data)
	}
}

func TestInstallRefusesAHashMismatch(t *testing.T) {
	archive := makeTarGz(t, tarEntry{name: "x/bin/x", body: "x"})
	server, _ := serve(t, map[string][]byte{"/x.tgz": archive})
	dep := archiveDep("x", server.URL+"/x.tgz", strings.Repeat("0", 64), 1, Bin{Path: "bin/x"})
	options := testOptions(t)
	err := Install(context.Background(), Selection{Deps: []Dep{dep}}, options)
	if err == nil || !strings.Contains(err.Error(), "sha256 mismatch") {
		t.Fatalf("err = %v, want sha256 mismatch", err)
	}
	if _, statErr := os.Stat(filepath.Join(options.Prefix, "tools", "x-1.0.0")); !errors.Is(statErr, os.ErrNotExist) {
		t.Fatalf("a refused download left a directory: %v", statErr)
	}
}

func TestInstallEnsuresOpenSSHServerFirst(t *testing.T) {
	options := testOptions(t)
	var order []string
	options.EnsureOpenSSHServer = func(context.Context) (bool, error) {
		order = append(order, "sshd")
		return true, nil
	}
	options.Report = func(timing Timing) { order = append(order, timing.Dep+":"+timing.Status) }
	if err := Install(context.Background(), Selection{OpenSSHServer: true}, options); err != nil {
		t.Fatal(err)
	}
	if strings.Join(order, ",") != "sshd,openssh-server:installed" {
		t.Fatalf("order = %v", order)
	}
}

func TestInstallNPMDepsUseTheLockfileNodeOnce(t *testing.T) {
	node := makeTarGz(t, tarEntry{name: "node-v1/bin/node", body: "node"})
	server, _ := serve(t, map[string][]byte{"/node.tgz": node})
	deps := []Dep{
		archiveDep("node", server.URL+"/node.tgz", sha(node), 1, Bin{Path: "bin/node"}),
		{Name: "claude-code", Version: "2.0.0", Kind: KindNPM, Package: "@anthropic-ai/claude-code", Bins: []string{"claude"}},
	}
	options := testOptions(t)
	var runs []string
	options.RunNPM = func(_ context.Context, nodeDir string, args []string, _ io.Writer) error {
		runs = append(runs, strings.Join(args, " "))
		if want := filepath.Join(options.Prefix, "tools", "node-1.0.0"); nodeDir != want {
			t.Fatalf("node dir = %s, want %s", nodeDir, want)
		}
		pkgDir := filepath.Join(options.Prefix, "npm", "lib", "node_modules", "@anthropic-ai", "claude-code")
		if err := os.MkdirAll(pkgDir, 0o755); err != nil {
			return err
		}
		return os.WriteFile(filepath.Join(pkgDir, "package.json"), []byte(`{"version":"2.0.0"}`), 0o644)
	}
	for range 2 {
		if err := Install(context.Background(), Selection{Deps: deps}, options); err != nil {
			t.Fatal(err)
		}
	}
	if len(runs) != 1 || !strings.HasSuffix(runs[0], "@anthropic-ai/claude-code@2.0.0") {
		t.Fatalf("npm runs = %q, want one install of the pinned version", runs)
	}
	target, _ := os.Readlink(filepath.Join(options.BinDir, "claude"))
	if want := filepath.Join(options.Prefix, "npm", "bin", "claude"); target != want {
		t.Fatalf("claude link = %s, want %s", target, want)
	}
}

func TestInstallNPMDepsRunOncePerSetOfFlags(t *testing.T) {
	node := makeTarGz(t, tarEntry{name: "node-v1/bin/node", body: "node"})
	server, _ := serve(t, map[string][]byte{"/node.tgz": node})
	deps := []Dep{
		archiveDep("node", server.URL+"/node.tgz", sha(node), 1, Bin{Path: "bin/node"}),
		{Name: "pi", Version: "1.0.0", Kind: KindNPM, Package: "@earendil-works/pi-coding-agent", Bins: []string{"pi"}, IgnoreScripts: true, EngineStrict: true},
		{Name: "opencode", Version: "2.0.0", Kind: KindNPM, Package: "opencode-ai", Bins: []string{"opencode"}},
		{Name: "pi-web", Version: "3.0.0", Kind: KindNPM, Package: "@agegr/pi-web", Bins: []string{"pi-web"}, IgnoreScripts: true, EngineStrict: true},
	}
	options := testOptions(t)
	var runs []string
	options.RunNPM = func(_ context.Context, _ string, args []string, _ io.Writer) error {
		runs = append(runs, strings.Join(args, " "))
		for _, arg := range args {
			at := strings.LastIndex(arg, "@")
			if at <= 0 || strings.HasPrefix(arg, "-") {
				continue
			}
			pkgDir := filepath.Join(options.Prefix, "npm", "lib", "node_modules", filepath.FromSlash(arg[:at]))
			if err := os.MkdirAll(pkgDir, 0o755); err != nil {
				return err
			}
			manifest := `{"version":"` + arg[at+1:] + `"}`
			if err := os.WriteFile(filepath.Join(pkgDir, "package.json"), []byte(manifest), 0o644); err != nil {
				return err
			}
		}
		return nil
	}
	if err := Install(context.Background(), Selection{Deps: deps}, options); err != nil {
		t.Fatal(err)
	}
	if len(runs) != 2 {
		t.Fatalf("npm runs = %q, want one per set of flags", runs)
	}
	if !strings.HasSuffix(runs[0], "--engine-strict --ignore-scripts @earendil-works/pi-coding-agent@1.0.0 @agegr/pi-web@3.0.0") {
		t.Fatalf("pi run = %q, want both Pi packages with the safe flags", runs[0])
	}
	if strings.Contains(runs[1], "--ignore-scripts") || strings.Contains(runs[1], "--engine-strict") || !strings.HasSuffix(runs[1], " opencode-ai@2.0.0") {
		t.Fatalf("opencode run = %q, want it without the Pi flags", runs[1])
	}
}

func TestInstallBinaryFormat(t *testing.T) {
	binary := []byte("\x7fELF fake")
	server, _ := serve(t, map[string][]byte{"/tool": binary})
	dep := Dep{
		Name: "tool", Version: "1.0.0", Kind: KindArchive,
		Artifacts: map[string]Artifact{"linux/amd64": {URL: server.URL + "/tool", SHA256: sha(binary), Format: FormatBinary, Bins: []Bin{{Path: "tool"}}}},
	}
	options := testOptions(t)
	if err := Install(context.Background(), Selection{Deps: []Dep{dep}}, options); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(filepath.Join(options.BinDir, "tool"))
	if err != nil || info.Mode().Perm()&0o111 == 0 {
		t.Fatalf("binary not executable through its link: %v %v", info, err)
	}
}

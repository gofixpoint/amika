package eventlog

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sort"
	"testing"
)

// fakeDownloader serves canned cloud bytes by object key for reconcile tests.
type fakeDownloader struct {
	data map[string][]byte
	err  error
}

func (f *fakeDownloader) Fetch(key string) ([]byte, bool, error) {
	if f.err != nil {
		return nil, false, f.err
	}
	b, ok := f.data[key]
	return b, ok, nil
}

// fakeMerger returns a canned merge result (or error) and counts invocations.
type fakeMerger struct {
	result []byte
	err    error
	calls  int
}

func (f *fakeMerger) Merge(_, _ []byte) ([]byte, error) {
	f.calls++
	if f.err != nil {
		return nil, f.err
	}
	return f.result, nil
}

// eventLineCWD renders one event line carrying a working directory and git info,
// as a Claude session's first line would.
func eventLineCWD(t *testing.T, cwd string, git *GitInfo) string {
	t.Helper()
	b, err := json.Marshal(Event{
		Source:    SourceClaude,
		HookEvent: "SessionStart",
		SessionID: "sess",
		CWD:       cwd,
		Git:       git,
		Payload:   json.RawMessage(`{}`),
	})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	return string(b)
}

func TestClaudeProjectDirName(t *testing.T) {
	cases := map[string]string{
		"/home/amika/workspace/amika": "-home-amika-workspace-amika",
		"/home/u/my.app":              "-home-u-my-app",
		"/work/a_b/c-d":               "-work-a-b-c-d",
		"relative/path":               "relative-path",
	}
	for in, want := range cases {
		if got := claudeProjectDirName(in); got != want {
			t.Errorf("claudeProjectDirName(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestCollectMemoryUnits(t *testing.T) {
	stateDir := t.TempDir()
	home := t.TempDir()
	cwd := "/work/myrepo"

	writeSessionFile(t, stateDir, SourceClaude, "20240101T000000.000000000Z_sess-a.jsonl",
		eventLineCWD(t, cwd, &GitInfo{RepoRoot: "/work/myrepo"}))

	memDir := filepath.Join(home, ".claude", "projects", "-work-myrepo", "memory")
	if err := os.MkdirAll(memDir, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	for name, body := range map[string]string{
		"foo.md":    "x",
		"MEMORY.md": "y", // uppercase name -> lowercased key
		"notes.txt": "z", // not markdown -> ignored
	} {
		if err := os.WriteFile(filepath.Join(memDir, name), []byte(body), 0o644); err != nil {
			t.Fatalf("write %s: %v", name, err)
		}
	}

	units, err := collectMemoryUnits(stateDir, home, false)
	if err != nil {
		t.Fatalf("collectMemoryUnits: %v", err)
	}
	got := make([]string, 0, len(units))
	for _, u := range units {
		got = append(got, u.objectKey)
	}
	sort.Strings(got)
	want := []string{"myrepo/claude/memory/foo.md", "myrepo/claude/memory/memory.md"}
	if len(got) != len(want) || got[0] != want[0] || got[1] != want[1] {
		t.Fatalf("object keys = %v, want %v", got, want)
	}
}

// reconcileFixture sets up one local memory file plus the fakes for a single
// reconcileMemory call.
type reconcileFixture struct {
	unit     memoryUnit
	manifest *memoryManifest
	up       *fakeUploader
	down     *fakeDownloader
	merger   *fakeMerger
}

func newReconcileFixture(t *testing.T, key, local string) *reconcileFixture {
	t.Helper()
	path := filepath.Join(t.TempDir(), "fact.md")
	if err := os.WriteFile(path, []byte(local), 0o644); err != nil {
		t.Fatalf("write local: %v", err)
	}
	return &reconcileFixture{
		unit:     memoryUnit{filePath: path, objectKey: key},
		manifest: &memoryManifest{Synced: map[string]memoryEntry{}},
		up:       newFakeUploader(),
		down:     &fakeDownloader{data: map[string][]byte{}},
		merger:   &fakeMerger{},
	}
}

func (f *reconcileFixture) localContent(t *testing.T) string {
	t.Helper()
	b, err := os.ReadFile(f.unit.filePath)
	if err != nil {
		t.Fatalf("read local: %v", err)
	}
	return string(b)
}

func TestReconcileMemory_NoCloudCopy_Uploads(t *testing.T) {
	f := newReconcileFixture(t, "repo/memory/f.md", "local")
	outcome, err := reconcileMemory(f.unit, f.manifest, false, f.up, f.down, f.merger)
	if err != nil || outcome != outcomeUploaded {
		t.Fatalf("outcome=%v err=%v, want uploaded", outcome, err)
	}
	if got := string(f.up.bytesFor("repo/memory/f.md")); got != "local" {
		t.Fatalf("uploaded %q, want %q", got, "local")
	}
	if f.manifest.Synced["repo/memory/f.md"].SyncedHash != hashBytes([]byte("local")) {
		t.Fatalf("manifest hash not set to local hash")
	}
}

func TestReconcileMemory_Identical_Skips(t *testing.T) {
	f := newReconcileFixture(t, "repo/memory/f.md", "same")
	f.down.data["repo/memory/f.md"] = []byte("same")
	outcome, err := reconcileMemory(f.unit, f.manifest, false, f.up, f.down, f.merger)
	if err != nil || outcome != outcomeSkipped {
		t.Fatalf("outcome=%v err=%v, want skipped", outcome, err)
	}
	if len(f.up.keys()) != 0 {
		t.Fatalf("unexpected upload: %v", f.up.keys())
	}
}

func TestReconcileMemory_OnlyLocalChanged_Uploads(t *testing.T) {
	f := newReconcileFixture(t, "repo/memory/f.md", "v2")
	f.down.data["repo/memory/f.md"] = []byte("v1")
	f.manifest.Synced["repo/memory/f.md"] = memoryEntry{ObjectKey: "repo/memory/f.md", SyncedHash: hashBytes([]byte("v1"))}
	outcome, err := reconcileMemory(f.unit, f.manifest, false, f.up, f.down, f.merger)
	if err != nil || outcome != outcomeUploaded {
		t.Fatalf("outcome=%v err=%v, want uploaded", outcome, err)
	}
	if got := string(f.up.bytesFor("repo/memory/f.md")); got != "v2" {
		t.Fatalf("uploaded %q, want v2", got)
	}
	if f.merger.calls != 0 {
		t.Fatalf("merger called unexpectedly")
	}
}

func TestReconcileMemory_OnlyCloudChanged_Pulls(t *testing.T) {
	f := newReconcileFixture(t, "repo/memory/f.md", "v1")
	f.down.data["repo/memory/f.md"] = []byte("v2")
	f.manifest.Synced["repo/memory/f.md"] = memoryEntry{ObjectKey: "repo/memory/f.md", SyncedHash: hashBytes([]byte("v1"))}
	outcome, err := reconcileMemory(f.unit, f.manifest, false, f.up, f.down, f.merger)
	if err != nil || outcome != outcomePulled {
		t.Fatalf("outcome=%v err=%v, want pulled", outcome, err)
	}
	if got := f.localContent(t); got != "v2" {
		t.Fatalf("local content %q, want v2 (pulled from cloud)", got)
	}
	if len(f.up.keys()) != 0 {
		t.Fatalf("unexpected upload on pull: %v", f.up.keys())
	}
	if f.manifest.Synced["repo/memory/f.md"].SyncedHash != hashBytes([]byte("v2")) {
		t.Fatalf("manifest hash not advanced to cloud hash")
	}
}

func TestReconcileMemory_BothChanged_Merges(t *testing.T) {
	f := newReconcileFixture(t, "repo/memory/f.md", "local-v2")
	f.down.data["repo/memory/f.md"] = []byte("cloud-v2")
	f.manifest.Synced["repo/memory/f.md"] = memoryEntry{ObjectKey: "repo/memory/f.md", SyncedHash: hashBytes([]byte("base-v1"))}
	f.merger.result = []byte("merged\n")

	outcome, err := reconcileMemory(f.unit, f.manifest, true, f.up, f.down, f.merger)
	if err != nil || outcome != outcomeMerged {
		t.Fatalf("outcome=%v err=%v, want merged", outcome, err)
	}
	if f.merger.calls != 1 {
		t.Fatalf("merger calls = %d, want 1", f.merger.calls)
	}
	if got := f.localContent(t); got != "merged\n" {
		t.Fatalf("local content %q, want merged", got)
	}
	if got := string(f.up.bytesFor("repo/memory/f.md")); got != "merged\n" {
		t.Fatalf("uploaded %q, want merged", got)
	}
	if f.manifest.Synced["repo/memory/f.md"].SyncedHash != hashBytes([]byte("merged\n")) {
		t.Fatalf("manifest hash not set to merged hash")
	}
}

func TestReconcileMemory_MergerUnavailable_DoesNotClobber(t *testing.T) {
	f := newReconcileFixture(t, "repo/memory/f.md", "local-v2")
	f.down.data["repo/memory/f.md"] = []byte("cloud-v2")
	f.manifest.Synced["repo/memory/f.md"] = memoryEntry{ObjectKey: "repo/memory/f.md", SyncedHash: hashBytes([]byte("base-v1"))}
	f.merger.err = ErrMergerUnavailable

	_, err := reconcileMemory(f.unit, f.manifest, true, f.up, f.down, f.merger)
	if !errors.Is(err, ErrMergerUnavailable) {
		t.Fatalf("err = %v, want ErrMergerUnavailable", err)
	}
	if got := f.localContent(t); got != "local-v2" {
		t.Fatalf("local content changed to %q on merge failure", got)
	}
	if len(f.up.keys()) != 0 {
		t.Fatalf("unexpected upload on merge failure: %v", f.up.keys())
	}
}

func TestReconcileMemory_MergeError_DoesNotClobber(t *testing.T) {
	f := newReconcileFixture(t, "repo/memory/f.md", "local-v2")
	f.down.data["repo/memory/f.md"] = []byte("cloud-v2")
	f.manifest.Synced["repo/memory/f.md"] = memoryEntry{ObjectKey: "repo/memory/f.md", SyncedHash: hashBytes([]byte("base-v1"))}
	f.merger.err = errors.New("boom")

	_, err := reconcileMemory(f.unit, f.manifest, true, f.up, f.down, f.merger)
	if err == nil || errors.Is(err, ErrMergerUnavailable) {
		t.Fatalf("err = %v, want a non-unavailable error", err)
	}
	if got := f.localContent(t); got != "local-v2" {
		t.Fatalf("local content changed to %q on merge failure", got)
	}
	if len(f.up.keys()) != 0 {
		t.Fatalf("unexpected upload on merge failure: %v", f.up.keys())
	}
}

func TestReconcileMemory_BothChanged_NoMerge_SkipsWithoutClobber(t *testing.T) {
	f := newReconcileFixture(t, "repo/memory/f.md", "local-v2")
	f.down.data["repo/memory/f.md"] = []byte("cloud-v2")
	f.manifest.Synced["repo/memory/f.md"] = memoryEntry{ObjectKey: "repo/memory/f.md", SyncedHash: hashBytes([]byte("base-v1"))}

	// merge=false: a both-sides divergence must surface as ErrMergeRequired
	// without invoking the merger or touching either copy.
	outcome, err := reconcileMemory(f.unit, f.manifest, false, f.up, f.down, f.merger)
	if !errors.Is(err, ErrMergeRequired) {
		t.Fatalf("err = %v, want ErrMergeRequired", err)
	}
	if outcome != outcomeSkipped {
		t.Fatalf("outcome = %v, want skipped", outcome)
	}
	if f.merger.calls != 0 {
		t.Fatalf("merger called %d times without --merge, want 0", f.merger.calls)
	}
	if got := f.localContent(t); got != "local-v2" {
		t.Fatalf("local content changed to %q without --merge", got)
	}
	if len(f.up.keys()) != 0 {
		t.Fatalf("unexpected upload without --merge: %v", f.up.keys())
	}
}

func TestPushMemories_UploadsThenSkipsAndWritesManifest(t *testing.T) {
	stateDir := t.TempDir()
	home := t.TempDir()
	cwd := "/work/myrepo"
	writeSessionFile(t, stateDir, SourceClaude, "20240101T000000.000000000Z_sess-a.jsonl",
		eventLineCWD(t, cwd, &GitInfo{RepoRoot: "/work/myrepo"}))
	memDir := filepath.Join(home, ".claude", "projects", "-work-myrepo", "memory")
	if err := os.MkdirAll(memDir, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(memDir, "fact.md"), []byte("hello"), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}

	up := newFakeUploader()
	down := &fakeDownloader{data: map[string][]byte{}}
	merger := &fakeMerger{}

	rep, err := PushMemories(stateDir, home, false, false, up, down, merger)
	if err != nil {
		t.Fatalf("PushMemories: %v", err)
	}
	if rep.Uploaded != 1 || rep.Failed != 0 {
		t.Fatalf("first run report = %+v, want 1 uploaded", rep)
	}
	if _, err := os.Stat(filepath.Join(stateDir, "events", memoryManifestName)); err != nil {
		t.Fatalf("manifest not written: %v", err)
	}

	// Second run: the cloud now holds what we uploaded, so it is a no-op skip.
	down.data["myrepo/claude/memory/fact.md"] = up.bytesFor("myrepo/claude/memory/fact.md")
	rep2, err := PushMemories(stateDir, home, false, false, up, down, merger)
	if err != nil {
		t.Fatalf("PushMemories second run: %v", err)
	}
	if rep2.Uploaded != 0 || rep2.Skipped != 1 {
		t.Fatalf("second run report = %+v, want 1 skipped", rep2)
	}
}

func TestCollectMemoryUnits_AllProjects(t *testing.T) {
	requireGit(t)
	stateDir := t.TempDir()
	home := t.TempDir()

	// Tracked project: amikalog captured a session recording its cwd + repo.
	trackedCwd := "/work/tracked"
	writeSessionFile(t, stateDir, SourceClaude, "20240101T000000.000000000Z_sess-a.jsonl",
		eventLineCWD(t, trackedCwd, &GitInfo{RepoRoot: "/work/tracked"}))
	trackedMem := filepath.Join(home, ".claude", "projects", "-work-tracked", "memory")
	if err := os.MkdirAll(trackedMem, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(trackedMem, "a.md"), []byte("a"), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}

	// Untracked project: no amikalog session, but a Claude transcript points at a
	// real git repo so its repo segment is recovered from git.
	repoDir := filepath.Join(t.TempDir(), "untracked-repo")
	if err := os.MkdirAll(repoDir, 0o755); err != nil {
		t.Fatalf("mkdir repo: %v", err)
	}
	initRepo(t, repoDir)
	untrackedProject := filepath.Join(home, ".claude", "projects", claudeProjectDirName(repoDir))
	if err := os.MkdirAll(filepath.Join(untrackedProject, "memory"), 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	// Claude's own transcript carries the working directory.
	if err := os.WriteFile(filepath.Join(untrackedProject, "transcript.jsonl"),
		[]byte(`{"cwd":"`+repoDir+`"}`+"\n"), 0o644); err != nil {
		t.Fatalf("write transcript: %v", err)
	}
	if err := os.WriteFile(filepath.Join(untrackedProject, "memory", "b.md"), []byte("b"), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}

	// Default mode: only the tracked project's memory is collected.
	got, err := collectMemoryUnits(stateDir, home, false)
	if err != nil {
		t.Fatalf("collectMemoryUnits(false): %v", err)
	}
	if len(got) != 1 || got[0].objectKey != "tracked/claude/memory/a.md" {
		t.Fatalf("default mode keys = %v, want [tracked/claude/memory/a.md]", keysOf(got))
	}

	// All-projects mode: both, with the untracked repo segment recovered from git.
	got, err = collectMemoryUnits(stateDir, home, true)
	if err != nil {
		t.Fatalf("collectMemoryUnits(true): %v", err)
	}
	wantUntracked := "untracked-repo/claude/memory/b.md"
	keys := keysOf(got)
	sort.Strings(keys)
	if len(keys) != 2 || keys[0] != "tracked/claude/memory/a.md" || keys[1] != wantUntracked {
		t.Fatalf("all-projects keys = %v, want [tracked/claude/memory/a.md %s]", keys, wantUntracked)
	}
}

func keysOf(units []memoryUnit) []string {
	ks := make([]string, 0, len(units))
	for _, u := range units {
		ks = append(ks, u.objectKey)
	}
	return ks
}

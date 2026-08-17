package eventlog

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"sync"
	"testing"
)

// fakeUploader records object keys (and bytes) it is asked to upload, and can
// be told to fail for specific keys. Push uploads in parallel, so all access is
// guarded by a mutex.
type fakeUploader struct {
	mu       sync.Mutex
	uploaded map[string][]byte
	failKeys map[string]bool
}

func newFakeUploader() *fakeUploader {
	return &fakeUploader{uploaded: map[string][]byte{}, failKeys: map[string]bool{}}
}

func (f *fakeUploader) Upload(objectKey string, data []byte) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.failKeys[objectKey] {
		return fmt.Errorf("forced failure for %s", objectKey)
	}
	// Copy: the caller may reuse the buffer after Upload returns.
	f.uploaded[objectKey] = append([]byte(nil), data...)
	return nil
}

func (f *fakeUploader) keys() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	ks := make([]string, 0, len(f.uploaded))
	for k := range f.uploaded {
		ks = append(ks, k)
	}
	sort.Strings(ks)
	return ks
}

func (f *fakeUploader) bytesFor(key string) []byte {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.uploaded[key]
}

// writeTestEvent writes one event JSON file into the on-disk layout under
// stateDir, returning the file path.
func writeTestEvent(t *testing.T, stateDir string, src Source, sessionDir string, seq int, git *GitInfo) string {
	t.Helper()
	dir := filepath.Join(EventsDir(stateDir, src), sessionDir)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	ev := Event{
		Source:    src,
		HookEvent: "PostToolUse",
		SessionID: "sess",
		Seq:       seq,
		Git:       git,
		Payload:   json.RawMessage(`{}`),
	}
	data, err := json.MarshalIndent(ev, "", "  ")
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	path := filepath.Join(dir, fmt.Sprintf("event_%d_20240101T000000.000000000Z.json", seq))
	if err := os.WriteFile(path, data, 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	return path
}

func TestPush_UploadsWithRepoPrefixedKeys(t *testing.T) {
	stateDir := t.TempDir()
	writeTestEvent(t, stateDir, SourceClaude, "20240101T000000.000000000Z_sess-a", 0, &GitInfo{RepoRoot: "/home/u/work/amika"})
	writeTestEvent(t, stateDir, SourceClaude, "20240101T000000.000000000Z_sess-a", 1, &GitInfo{RepoRoot: "/home/u/work/amika"})
	// A codex session with no git context falls back to the unknown-repo prefix.
	writeTestEvent(t, stateDir, SourceCodex, "20240101T000000.000000000Z_sess-b", 0, nil)

	up := newFakeUploader()
	report, err := Push(stateDir, up)
	if err != nil {
		t.Fatalf("Push: %v", err)
	}
	if report.Uploaded != 3 || report.Skipped != 0 || report.Failed != 0 {
		t.Fatalf("report = %+v, want uploaded=3 skipped=0 failed=0", report)
	}

	// On-disk names are uppercase, but object keys are lowercased at upload so
	// they round-trip through case-folding storage listings.
	want := []string{
		"amika/sessions/claude/20240101t000000.000000000z_sess-a/event_0_20240101t000000.000000000z.json",
		"amika/sessions/claude/20240101t000000.000000000z_sess-a/event_1_20240101t000000.000000000z.json",
		"unknown-repo/sessions/codex/20240101t000000.000000000z_sess-b/event_0_20240101t000000.000000000z.json",
	}
	got := up.keys()
	if len(got) != len(want) {
		t.Fatalf("uploaded keys = %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("key[%d] = %q, want %q", i, got[i], want[i])
		}
	}
}

func TestPush_SecondRunSkipsAlreadyUploaded(t *testing.T) {
	stateDir := t.TempDir()
	writeTestEvent(t, stateDir, SourceClaude, "20240101T000000.000000000Z_sess-a", 0, &GitInfo{RepoRoot: "/x/amika"})

	first := newFakeUploader()
	r1, err := Push(stateDir, first)
	if err != nil {
		t.Fatalf("Push #1: %v", err)
	}
	if r1.Uploaded != 1 {
		t.Fatalf("first run uploaded = %d, want 1", r1.Uploaded)
	}

	// A new file appears; the second run uploads only that one.
	writeTestEvent(t, stateDir, SourceClaude, "20240101T000000.000000000Z_sess-a", 1, &GitInfo{RepoRoot: "/x/amika"})
	second := newFakeUploader()
	r2, err := Push(stateDir, second)
	if err != nil {
		t.Fatalf("Push #2: %v", err)
	}
	if r2.Uploaded != 1 || r2.Skipped != 1 {
		t.Fatalf("second run = %+v, want uploaded=1 skipped=1", r2)
	}
	if len(second.uploaded) != 1 {
		t.Errorf("second run uploaded %d objects, want 1", len(second.uploaded))
	}
}

func TestPush_FailedUploadIsNotMarkedDone(t *testing.T) {
	stateDir := t.TempDir()
	writeTestEvent(t, stateDir, SourceClaude, "20240101T000000.000000000Z_sess-a", 0, &GitInfo{RepoRoot: "/x/amika"})
	key := "amika/sessions/claude/20240101t000000.000000000z_sess-a/event_0_20240101t000000.000000000z.json"

	failing := newFakeUploader()
	failing.failKeys[key] = true
	r1, err := Push(stateDir, failing)
	if err != nil {
		t.Fatalf("Push: %v", err)
	}
	if r1.Failed != 1 || r1.Uploaded != 0 {
		t.Fatalf("report = %+v, want failed=1 uploaded=0", r1)
	}

	// A subsequent successful run retries the previously-failed file.
	ok := newFakeUploader()
	r2, err := Push(stateDir, ok)
	if err != nil {
		t.Fatalf("Push retry: %v", err)
	}
	if r2.Uploaded != 1 || r2.Skipped != 0 {
		t.Fatalf("retry report = %+v, want uploaded=1 skipped=0", r2)
	}
}

func TestPush_NoEventsIsNoOp(t *testing.T) {
	report, err := Push(t.TempDir(), newFakeUploader())
	if err != nil {
		t.Fatalf("Push: %v", err)
	}
	if report.Uploaded != 0 || report.Skipped != 0 || report.Failed != 0 {
		t.Fatalf("report = %+v, want all zero", report)
	}
}

// eventLine renders one event as a compact JSON line, as capture appends it.
func eventLine(t *testing.T, git *GitInfo, seq int) string {
	t.Helper()
	b, err := json.Marshal(Event{
		Source:    SourceClaude,
		HookEvent: "PostToolUse",
		SessionID: "sess",
		Seq:       seq,
		Git:       git,
		Payload:   json.RawMessage(`{}`),
	})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	return string(b)
}

// writeSessionFile writes a session JSONL file (newline-terminated lines) under
// the on-disk layout for src, returning its path.
func writeSessionFile(t *testing.T, stateDir string, src Source, name string, lines ...string) string {
	t.Helper()
	dir := EventsDir(stateDir, src)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	path := filepath.Join(dir, name)
	if err := os.WriteFile(path, []byte(strings.Join(lines, "\n")+"\n"), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	return path
}

func TestPush_UploadsJSONLSessionFiles(t *testing.T) {
	stateDir := t.TempDir()
	writeSessionFile(t, stateDir, SourceClaude, "20240101T000000.000000000Z_sess-a.jsonl",
		eventLine(t, &GitInfo{RepoRoot: "/home/u/work/amika"}, 0),
		eventLine(t, &GitInfo{RepoRoot: "/home/u/work/amika"}, 1),
	)
	// A session whose events carry no git context falls back to unknown-repo.
	writeSessionFile(t, stateDir, SourceCodex, "20240101T000000.000000000Z_sess-b.jsonl",
		eventLine(t, nil, 0),
	)

	up := newFakeUploader()
	report, err := Push(stateDir, up)
	if err != nil {
		t.Fatalf("Push: %v", err)
	}
	// One upload per session file, not per event.
	if report.Uploaded != 2 || report.Skipped != 0 || report.Failed != 0 {
		t.Fatalf("report = %+v, want uploaded=2 skipped=0 failed=0", report)
	}
	want := []string{
		"amika/sessions/claude/20240101t000000.000000000z_sess-a.jsonl",
		"unknown-repo/sessions/codex/20240101t000000.000000000z_sess-b.jsonl",
	}
	if got := up.keys(); !reflect.DeepEqual(got, want) {
		t.Fatalf("uploaded keys = %v, want %v", got, want)
	}
}

func TestPush_JSONLNestedRepoPathFromRemote(t *testing.T) {
	// When events carry an origin remote, the session is filed under the full
	// host/owner/repo path (nested as folders), not the repo-root basename, so
	// two checkouts that share a basename do not collide.
	stateDir := t.TempDir()
	writeSessionFile(t, stateDir, SourceClaude, "20240101T000000.000000000Z_sess-a.jsonl",
		eventLine(t, &GitInfo{RepoRoot: "/home/u/work/amika", Remote: "github.com/fixpoint/amika"}, 0),
	)
	writeSessionFile(t, stateDir, SourceCodex, "20240101T000000.000000000Z_sess-b.jsonl",
		eventLine(t, &GitInfo{RepoRoot: "/home/u/other/amika", Remote: "github.com/otherorg/amika"}, 0),
	)

	up := newFakeUploader()
	if _, err := Push(stateDir, up); err != nil {
		t.Fatalf("Push: %v", err)
	}
	want := []string{
		"github.com/fixpoint/amika/sessions/claude/20240101t000000.000000000z_sess-a.jsonl",
		"github.com/otherorg/amika/sessions/codex/20240101t000000.000000000z_sess-b.jsonl",
	}
	if got := up.keys(); !reflect.DeepEqual(got, want) {
		t.Fatalf("uploaded keys = %v, want %v", got, want)
	}
}

func TestPush_JSONLRepoPrefixFromLaterLine(t *testing.T) {
	// The first event has no git context but a later one does. The repo prefix is
	// derived from the whole locked snapshot, so the session must still be filed
	// under its repo rather than unknown-repo.
	stateDir := t.TempDir()
	writeSessionFile(t, stateDir, SourceClaude, "20240101T000000.000000000Z_sess-a.jsonl",
		eventLine(t, nil, 0),
		eventLine(t, &GitInfo{RepoRoot: "/home/u/work/amika"}, 1),
	)

	up := newFakeUploader()
	if _, err := Push(stateDir, up); err != nil {
		t.Fatalf("Push: %v", err)
	}
	want := []string{"amika/sessions/claude/20240101t000000.000000000z_sess-a.jsonl"}
	if got := up.keys(); !reflect.DeepEqual(got, want) {
		t.Fatalf("uploaded keys = %v, want %v", got, want)
	}
}

func TestPush_JSONLRepoPrefixNotCappedByLineSize(t *testing.T) {
	// An event line larger than any fixed scanner cap must still have its git
	// context read, so the session is filed under its repo, not unknown-repo.
	stateDir := t.TempDir()
	huge, err := json.Marshal(Event{
		Source:    SourceClaude,
		HookEvent: "PostToolUse",
		SessionID: "sess",
		Git:       &GitInfo{RepoRoot: "/home/u/work/amika"},
		Payload:   json.RawMessage(`"` + strings.Repeat("x", 16*1024*1024+1024) + `"`),
	})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	writeSessionFile(t, stateDir, SourceClaude, "20240101T000000.000000000Z_sess-a.jsonl", string(huge))

	up := newFakeUploader()
	if _, err := Push(stateDir, up); err != nil {
		t.Fatalf("Push: %v", err)
	}
	want := []string{"amika/sessions/claude/20240101t000000.000000000z_sess-a.jsonl"}
	if got := up.keys(); !reflect.DeepEqual(got, want) {
		t.Fatalf("uploaded keys = %v, want %v", got, want)
	}
}

func TestPush_UploadsOnlyCompleteRecords(t *testing.T) {
	// A crash can leave a partial trailing record (no final newline). Push must
	// upload only the whole records, never the partial tail.
	stateDir := t.TempDir()
	name := "20240101T000000.000000000Z_sess-a.jsonl"
	key := "amika/sessions/claude/20240101t000000.000000000z_sess-a.jsonl"
	dir := EventsDir(stateDir, SourceClaude)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	body := eventLine(t, &GitInfo{RepoRoot: "/x/amika"}, 0) + "\n" +
		eventLine(t, &GitInfo{RepoRoot: "/x/amika"}, 1) + "\n" +
		`{"seq":2,"incomplete` // partial tail, no trailing newline
	if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}

	up := newFakeUploader()
	if _, err := Push(stateDir, up); err != nil {
		t.Fatalf("Push: %v", err)
	}
	got := string(up.bytesFor(key))
	if strings.Contains(got, "incomplete") {
		t.Errorf("uploaded the partial record:\n%s", got)
	}
	if n := strings.Count(got, "\n"); n != 2 {
		t.Errorf("uploaded %d complete records, want 2", n)
	}
}

func TestPush_PinsObjectKeyAcrossPushes(t *testing.T) {
	// First push has no git context, so the key uses the unknown-repo prefix. A
	// later event adds git context, but the key must stay pinned to the original
	// so a second object (a duplicate prefix of the session) is never created.
	stateDir := t.TempDir()
	name := "20240101T000000.000000000Z_sess-a.jsonl"
	path := filepath.Join(EventsDir(stateDir, SourceClaude), name)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	wantKey := "unknown-repo/sessions/claude/20240101t000000.000000000z_sess-a.jsonl"

	if err := os.WriteFile(path, []byte(eventLine(t, nil, 0)+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	up1 := newFakeUploader()
	if r, err := Push(stateDir, up1); err != nil || r.Uploaded != 1 {
		t.Fatalf("push #1 = %+v (err %v), want uploaded=1", r, err)
	}
	if got := up1.keys(); !reflect.DeepEqual(got, []string{wantKey}) {
		t.Fatalf("push #1 keys = %v, want %v", got, []string{wantKey})
	}

	// Append an event that does carry git context.
	body := eventLine(t, nil, 0) + "\n" + eventLine(t, &GitInfo{RepoRoot: "/x/amika"}, 1) + "\n"
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	up2 := newFakeUploader()
	if r, err := Push(stateDir, up2); err != nil || r.Uploaded != 1 {
		t.Fatalf("push #2 = %+v (err %v), want uploaded=1", r, err)
	}
	if got := up2.keys(); !reflect.DeepEqual(got, []string{wantKey}) {
		t.Fatalf("push #2 used key %v, want pinned %v (no duplicate under repo prefix)", got, []string{wantKey})
	}
}

func TestPush_RecordsUploadedSizeNotFullFileSize(t *testing.T) {
	// A crash-left partial tail is uploaded as complete records only, and the
	// fingerprint must be the uploaded size, not the full file size. Otherwise a
	// heal that replaces the partial tail with a real event of the same length
	// returns the file to the old full size and the skip check would wrongly drop
	// the new event.
	stateDir := t.TempDir()
	name := "20240101T000000.000000000Z_sess-a.jsonl"
	key := "amika/sessions/claude/20240101t000000.000000000z_sess-a.jsonl"
	path := filepath.Join(EventsDir(stateDir, SourceClaude), name)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}

	git := &GitInfo{RepoRoot: "/x/amika"}
	ev0 := eventLine(t, git, 0)
	ev1 := eventLine(t, git, 1)

	// v1: one complete record plus a partial tail exactly as long as the real
	// ev1 line (incl newline) will be, so healing+appending ev1 returns the file
	// to the same full byte size.
	partial := strings.Repeat("x", len(ev1)+1)
	if err := os.WriteFile(path, []byte(ev0+"\n"+partial), 0o644); err != nil {
		t.Fatal(err)
	}
	up1 := newFakeUploader()
	if r, err := Push(stateDir, up1); err != nil || r.Uploaded != 1 {
		t.Fatalf("push #1 = %+v (err %v), want uploaded=1", r, err)
	}
	if got := up1.bytesFor(key); strings.Count(string(got), "\n") != 1 {
		t.Fatalf("push #1 uploaded %q, want only the one complete record", got)
	}

	// Heal the partial and append a real ev1; the full size now equals v1's size.
	if err := os.WriteFile(path, []byte(ev0+"\n"+ev1+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	up2 := newFakeUploader()
	r, err := Push(stateDir, up2)
	if err != nil {
		t.Fatalf("push #2: %v", err)
	}
	if r.Uploaded != 1 || r.Skipped != 0 {
		t.Fatalf("push #2 = %+v, want uploaded=1 skipped=0 (must not skip on equal full size)", r)
	}
	if n := strings.Count(string(up2.bytesFor(key)), "\n"); n != 2 {
		t.Errorf("push #2 uploaded %d records, want 2", n)
	}
}

func TestPush_ReuploadsGrownSessionAndSkipsUnchanged(t *testing.T) {
	stateDir := t.TempDir()
	name := "20240101T000000.000000000Z_sess-a.jsonl"
	key := "amika/sessions/claude/20240101t000000.000000000z_sess-a.jsonl"
	git := &GitInfo{RepoRoot: "/x/amika"}

	writeSessionFile(t, stateDir, SourceClaude, name, eventLine(t, git, 0))
	if r, err := Push(stateDir, newFakeUploader()); err != nil || r.Uploaded != 1 {
		t.Fatalf("first push = %+v (err %v), want uploaded=1", r, err)
	}

	// Unchanged file: skipped, not re-uploaded.
	if r, err := Push(stateDir, newFakeUploader()); err != nil || r.Uploaded != 0 || r.Skipped != 1 {
		t.Fatalf("unchanged push = %+v (err %v), want uploaded=0 skipped=1", r, err)
	}

	// Append a second event: the file grew, so it re-uploads with both lines.
	writeSessionFile(t, stateDir, SourceClaude, name, eventLine(t, git, 0), eventLine(t, git, 1))
	up := newFakeUploader()
	if r, err := Push(stateDir, up); err != nil || r.Uploaded != 1 || r.Skipped != 0 {
		t.Fatalf("grown push = %+v (err %v), want uploaded=1 skipped=0", r, err)
	}
	if n := strings.Count(string(up.bytesFor(key)), "\n"); n != 2 {
		t.Errorf("re-uploaded body has %d lines, want 2", n)
	}
}

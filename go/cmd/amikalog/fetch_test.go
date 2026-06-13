package main

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"sync"
	"testing"
)

// fakeBucketDownloader serves a fixed set of objects keyed by bucket key in a
// single page, and can be told to fail the listing or an individual object's
// fetch.
type fakeBucketDownloader struct {
	data    map[string][]byte
	listErr error
	getErr  map[string]error
}

func (f fakeBucketDownloader) ListPage(string) ([]bucketObject, string, error) {
	if f.listErr != nil {
		return nil, "", f.listErr
	}
	keys := make([]string, 0, len(f.data))
	for k := range f.data {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	objs := make([]bucketObject, 0, len(keys))
	for _, k := range keys {
		objs = append(objs, bucketObject{key: k, downloadURL: "https://signed/" + k})
	}
	return objs, "", nil
}

func (f fakeBucketDownloader) Get(obj bucketObject) ([]byte, error) {
	if err := f.getErr[obj.key]; err != nil {
		return nil, err
	}
	data, ok := f.data[obj.key]
	if !ok {
		return nil, fmt.Errorf("not found: %s", obj.key)
	}
	return data, nil
}

func TestRunFetch_RecreatesBucketTree(t *testing.T) {
	dir := t.TempDir()
	d := fakeBucketDownloader{data: map[string][]byte{
		"amika/claude/sessions/s/event_0.json":       []byte(`{"k":0}`),
		"amika/claude/sessions/s/event_1.json":       []byte(`{"k":1}`),
		"unknown-repo/codex/sessions/t/event_0.json": []byte("x"),
	}}

	n, err := runFetch(d, dir)
	if err != nil {
		t.Fatalf("runFetch: %v", err)
	}
	if n != 3 {
		t.Errorf("n = %d, want 3", n)
	}
	for key, want := range d.data {
		got, err := os.ReadFile(filepath.Join(dir, filepath.FromSlash(key)))
		if err != nil {
			t.Fatalf("reading %s: %v", key, err)
		}
		if string(got) != string(want) {
			t.Errorf("%s = %q, want %q", key, string(got), string(want))
		}
	}
}

func TestRunFetch_PropagatesListError(t *testing.T) {
	d := fakeBucketDownloader{listErr: fmt.Errorf("boom")}
	if _, err := runFetch(d, t.TempDir()); err == nil {
		t.Fatal("expected error from List, got nil")
	}
}

func TestRunFetch_PropagatesDownloadError(t *testing.T) {
	d := fakeBucketDownloader{
		data:   map[string][]byte{"amika/x.json": []byte("x")},
		getErr: map[string]error{"amika/x.json": fmt.Errorf("nope")},
	}
	if _, err := runFetch(d, t.TempDir()); err == nil {
		t.Fatal("expected error from Get, got nil")
	}
}

// opsLog records list/get calls; access is mutex-guarded because a page's
// objects are fetched concurrently.
type opsLog struct {
	mu  sync.Mutex
	ops []string
}

func (o *opsLog) add(s string) {
	o.mu.Lock()
	defer o.mu.Unlock()
	o.ops = append(o.ops, s)
}

func (o *opsLog) snapshot() []string {
	o.mu.Lock()
	defer o.mu.Unlock()
	return append([]string(nil), o.ops...)
}

// pagedBucketDownloader serves objects across multiple pages and records the
// order of list/get calls, so a test can assert each page is downloaded before
// the next is listed (signed URLs are used promptly, not after the full walk).
type pagedBucketDownloader struct {
	pages [][]bucketObject
	rec   *opsLog
}

func (p pagedBucketDownloader) ListPage(cursor string) ([]bucketObject, string, error) {
	p.rec.add("list:" + cursor)
	idx := 0
	if cursor != "" {
		idx, _ = strconv.Atoi(cursor)
	}
	if idx >= len(p.pages) {
		return nil, "", nil
	}
	next := ""
	if idx+1 < len(p.pages) {
		next = strconv.Itoa(idx + 1)
	}
	return p.pages[idx], next, nil
}

func (p pagedBucketDownloader) Get(obj bucketObject) ([]byte, error) {
	p.rec.add("get:" + obj.key)
	return []byte(obj.key), nil
}

func TestRunFetch_RejectsSymlinkedDirEscape(t *testing.T) {
	dir := t.TempDir()
	outside := t.TempDir()
	// A symlinked subdirectory in the destination pointing outside it.
	if err := os.Symlink(outside, filepath.Join(dir, "amika")); err != nil {
		t.Fatalf("symlink: %v", err)
	}
	d := fakeBucketDownloader{data: map[string][]byte{"amika/evil.json": []byte("pwned")}}

	if _, err := runFetch(d, dir); err == nil {
		t.Fatal("expected error for symlinked directory escape, got nil")
	}
	if _, err := os.Stat(filepath.Join(outside, "evil.json")); !os.IsNotExist(err) {
		t.Errorf("write escaped the destination into %s", outside)
	}
}

func TestRunFetch_RejectsSymlinkedLeaf(t *testing.T) {
	dir := t.TempDir()
	outside := t.TempDir()
	// A symlink at the object's own path pointing outside the destination.
	if err := os.Symlink(filepath.Join(outside, "secret"), filepath.Join(dir, "evil.json")); err != nil {
		t.Fatalf("symlink: %v", err)
	}
	d := fakeBucketDownloader{data: map[string][]byte{"evil.json": []byte("pwned")}}

	if _, err := runFetch(d, dir); err == nil {
		t.Fatal("expected error for symlinked leaf, got nil")
	}
	if _, err := os.Stat(filepath.Join(outside, "secret")); !os.IsNotExist(err) {
		t.Errorf("write escaped the destination into %s", outside)
	}
}

func TestRunFetch_DownloadsEachPageBeforeListingNext(t *testing.T) {
	d := pagedBucketDownloader{
		pages: [][]bucketObject{
			{{key: "p0a.json"}, {key: "p0b.json"}},
			{{key: "p1a.json"}},
		},
		rec: &opsLog{},
	}

	n, err := runFetch(d, t.TempDir())
	if err != nil {
		t.Fatalf("runFetch: %v", err)
	}
	if n != 3 {
		t.Errorf("n = %d, want 3", n)
	}

	// A page's objects are fetched in parallel, so their relative order is not
	// fixed; what must hold is that every get for a page happens between that
	// page's list and the next page's list.
	ops := d.rec.snapshot()
	if len(ops) != 5 {
		t.Fatalf("ops = %v, want 5 entries", ops)
	}
	if ops[0] != "list:" {
		t.Errorf("ops[0] = %q, want list:", ops[0])
	}
	if page0 := map[string]bool{ops[1]: true, ops[2]: true}; !page0["get:p0a.json"] || !page0["get:p0b.json"] {
		t.Errorf("ops[1:3] = %v, want page-0 gets before list:1", ops[1:3])
	}
	if ops[3] != "list:1" {
		t.Errorf("ops[3] = %q, want list:1", ops[3])
	}
	if ops[4] != "get:p1a.json" {
		t.Errorf("ops[4] = %q, want get:p1a.json", ops[4])
	}
}

func TestBucketObjectPath(t *testing.T) {
	dir := t.TempDir()
	tests := []struct {
		name    string
		destDir string // defaults to the temp dir when empty
		key     string
		wantErr bool
		want    string
	}{
		{
			name: "nested key preserved",
			key:  "amika/claude/sessions/s/event_0.json",
			want: filepath.Join(dir, "amika", "claude", "sessions", "s", "event_0.json"),
		},
		{
			name: "top-level key",
			key:  "x.json",
			want: filepath.Join(dir, "x.json"),
		},
		{
			name:    "escaping key rejected",
			key:     "../evil.json",
			wantErr: true,
		},
		{
			name:    "current-dir destination",
			destDir: ".",
			key:     "amika/claude/x.json",
			want:    filepath.Join(".", "amika", "claude", "x.json"),
		},
		{
			name:    "escaping key rejected from current dir",
			destDir: ".",
			key:     "../evil.json",
			wantErr: true,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			destDir := dir
			if tt.destDir != "" {
				destDir = tt.destDir
			}
			got, err := bucketObjectPath(destDir, tt.key)
			if tt.wantErr {
				if err == nil {
					t.Fatalf("expected error for key %q, got %q", tt.key, got)
				}
				return
			}
			if err != nil {
				t.Fatalf("bucketObjectPath(%q): %v", tt.key, err)
			}
			if got != tt.want {
				t.Errorf("bucketObjectPath(%q) = %q, want %q", tt.key, got, tt.want)
			}
		})
	}
}

package eventlog

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
	"sync"
)

// Uploader uploads one object's bytes under the given object key. The key uses
// forward slashes and is a relative path within the destination bucket.
// Implementations must be safe for concurrent use: Push uploads in parallel.
type Uploader interface {
	Upload(objectKey string, data []byte) error
}

// PushReport summarizes a Push run.
type PushReport struct {
	// Uploaded is the number of session files uploaded this run.
	Uploaded int
	// Skipped is the number of session files already up to date in the manifest.
	Skipped int
	// Failed is the number of session files whose upload returned an error.
	Failed int
	// Errors holds one error per failed file (parallel to Failed).
	Errors []error
}

// pushManifestName is the file under <state>/events that records which event
// files have already been uploaded, so repeated pushes are incremental.
const pushManifestName = ".amikalog-push-state.json"

// pushLockName is the advisory lock file under <state>/events that serializes
// concurrent beta:push runs.
const pushLockName = ".amikalog-push.lock"

// unknownRepoSegment is the object-key repository path used for a session whose
// events carry no git repository context.
const unknownRepoSegment = "unknown-repo"

// pushConcurrency bounds how many session files Push uploads at once.
const pushConcurrency = 8

// legacyUploaded marks a manifest entry written before uploads were tracked by
// size (the value was an RFC3339 timestamp). Such a file was already uploaded,
// so it is skipped regardless of its current size — safe because the only files
// the old scheme tracked are the per-event JSON files, which are immutable.
const legacyUploaded int64 = -1

// manifestEntry records what was last uploaded for a file.
type manifestEntry struct {
	// Size is the byte length of the payload last uploaded. A session JSONL file
	// grows as events are appended, so a size mismatch means new events to push;
	// an unchanged size is skipped. legacyUploaded means "already uploaded under
	// an older scheme, skip regardless of size".
	Size int64 `json:"size"`
	// ObjectKey is the destination key the file was first uploaded under, pinned
	// so a session's key never changes — e.g. a session first pushed before any
	// event carried git context (uploaded under "unknown-repo") keeps that key
	// rather than creating a second object once git context appears.
	ObjectKey string `json:"object_key,omitempty"`
}

// pushManifest tracks uploaded files keyed by their path relative to
// <state>/events (e.g. "claude/sessions/<ts>_<sess>.jsonl").
type pushManifest struct {
	Uploaded map[string]manifestEntry `json:"uploaded"`
}

// UnmarshalJSON reads the manifest, tolerating two older value shapes: a bare
// byte-size number (before the object key was pinned) and an upload-timestamp
// string (before uploads were tracked by size, mapped to legacyUploaded). This
// lets a format change reuse the existing manifest instead of re-pushing the
// whole history.
func (m *pushManifest) UnmarshalJSON(data []byte) error {
	var raw struct {
		Uploaded map[string]json.RawMessage `json:"uploaded"`
	}
	if err := json.Unmarshal(data, &raw); err != nil {
		return err
	}
	m.Uploaded = make(map[string]manifestEntry, len(raw.Uploaded))
	for k, v := range raw.Uploaded {
		var entry manifestEntry
		if err := json.Unmarshal(v, &entry); err == nil {
			m.Uploaded[k] = entry
			continue
		}
		var size int64
		if err := json.Unmarshal(v, &size); err == nil {
			m.Uploaded[k] = manifestEntry{Size: size}
			continue
		}
		m.Uploaded[k] = manifestEntry{Size: legacyUploaded}
	}
	return nil
}

// uploadUnit is one file Push may upload.
type uploadUnit struct {
	// relKey is the file's path relative to <state>/events, slash-separated
	// ("<source>/sessions/<tail>"); it keys the manifest.
	relKey string
	// source is the event source (claude or codex). The object key places it
	// after the repository path and "sessions/" segment, so it must be carried
	// explicitly rather than left implicit in relKey's leading segment.
	source Source
	// repoPath is the object-key repository path for legacy per-event files,
	// resolved at collection time (they are immutable). It is empty for session
	// JSONL files, whose path is derived from the locked snapshot instead — see
	// objectKeyFor.
	repoPath string
	// filePath is the absolute on-disk path of the file.
	filePath string
	// lockPath is the advisory lock to hold while snapshotting filePath, or ""
	// for immutable legacy per-event files that need no lock.
	lockPath string
	// size is the file's size at collection time, compared against the manifest
	// to skip unchanged files.
	size int64
}

// objectKeyFor returns the destination object key for the snapshot bytes:
// "<repo-path>/sessions/<source>/<tail>", where <tail> is the file's path after
// the on-disk "<source>/sessions/" prefix (a session file name, or a legacy
// session dir plus event file). <repo-path> is the session's repository
// identity — its "origin" remote as "host/owner/repo" when captured, else the
// repository basename, else "unknown-repo" — nested as bucket folders so two
// checkouts sharing a basename do not collide. For a session JSONL file
// (repoPath empty) it is derived from the snapshot, which was read under the
// lock, so a push racing the session's first write cannot misfile a completed
// event under "unknown-repo".
func (u uploadUnit) objectKeyFor(data []byte) string {
	repoPath := u.repoPath
	if repoPath == "" {
		repoPath = repoPathFromJSONL(data)
	}
	tail := strings.TrimPrefix(u.relKey, string(u.source)+"/sessions/")
	return strings.ToLower(path.Join(repoPath, "sessions", string(u.source), tail))
}

// Push uploads every changed session file under stateDir to up, recording each
// success in a local manifest so subsequent runs only send files that grew.
//
// New sessions are stored as one append-only JSONL file per session; its object
// key is "<repo-path>/sessions/<source>/<ts>_<sess>.jsonl", where <repo-path>
// is the session's repository identity: its captured "origin" remote as
// "host/owner/repo", falling back to the git.repo_root basename, then to
// "unknown-repo". Legacy per-event JSON files (from before the JSONL format)
// are still uploaded so already-captured events are not lost.
//
// A session's key is pinned on first upload (see manifestEntry.ObjectKey), so
// sessions already pushed under an older key layout keep it — the new layout
// applies going forward, and no object is ever duplicated or orphaned.
//
// Uploads run in parallel (bounded by pushConcurrency). Per-file failures are
// collected in the report and do not abort the run; a non-nil error is returned
// only for failures that prevent the walk itself (e.g. an unreadable manifest).
func Push(stateDir string, up Uploader) (PushReport, error) {
	eventsBase := filepath.Join(stateDir, "events")
	if err := os.MkdirAll(eventsBase, 0o755); err != nil {
		return PushReport{}, fmt.Errorf("creating events dir %s: %w", eventsBase, err)
	}

	// Serialize concurrent pushes for the whole run. Two overlapping pushes could
	// otherwise upload snapshots of the same growing session out of order;
	// because uploads upsert, a late older snapshot would overwrite a newer one
	// with fewer records, and the manifest would then mark the larger size as
	// done — stranding the appended events in the bucket until the file grows
	// again. (This lock is distinct from the per-source capture lock that
	// snapshotOrSkip takes; a push acquires this one first, so there is no
	// ordering cycle with hooks, which only take the capture lock.)
	pushLock, err := acquireLock(filepath.Join(eventsBase, pushLockName))
	if err != nil {
		return PushReport{}, err
	}
	defer pushLock.release()

	manifestPath := filepath.Join(eventsBase, pushManifestName)
	manifest, err := loadPushManifest(manifestPath)
	if err != nil {
		return PushReport{}, err
	}

	units, err := collectUploadUnits(stateDir, eventsBase)
	if err != nil {
		return PushReport{}, err
	}

	var report PushReport
	saveErr := processUnits(up, manifest, manifestPath, units, &report)
	return report, saveErr
}

// processUnits handles each unit concurrently: it takes a locked snapshot,
// skips the file when its current size already matches the manifest, otherwise
// uploads it (reusing the file's pinned object key if it has one) and records
// the new size and key. The manifest is persisted after every upload so an
// interrupted run resumes cleanly. It returns the first manifest-save error
// encountered, if any; per-file upload failures are recorded in report instead.
func processUnits(up Uploader, manifest *pushManifest, manifestPath string, units []uploadUnit, report *PushReport) error {
	var (
		mu        sync.Mutex
		saveErr   error
		wg        sync.WaitGroup
		semaphore = make(chan struct{}, pushConcurrency)
	)
	for _, u := range units {
		u := u
		semaphore <- struct{}{}
		wg.Add(1)
		go func() {
			defer wg.Done()
			defer func() { <-semaphore }()

			mu.Lock()
			entry, known := manifest.Uploaded[u.relKey]
			mu.Unlock()

			payload, fingerprint, skip, err := snapshotOrSkip(u, entry.Size, known)
			if err != nil {
				mu.Lock()
				report.Failed++
				report.Errors = append(report.Errors, err)
				mu.Unlock()
				return
			}
			// skip: already up to date. Empty payload: only a partial record so
			// far (e.g. a crash before the first newline) — nothing complete to
			// upload yet, so leave it unrecorded and retry on a later run.
			if skip || len(payload) == 0 {
				mu.Lock()
				report.Skipped++
				mu.Unlock()
				return
			}
			// Reuse the key the session was first uploaded under, if any, so its
			// prefix never changes (e.g. unknown-repo -> repo once git appears).
			objectKey := entry.ObjectKey
			if objectKey == "" {
				objectKey = u.objectKeyFor(payload)
			}
			if err := up.Upload(objectKey, payload); err != nil {
				mu.Lock()
				report.Failed++
				report.Errors = append(report.Errors, fmt.Errorf("uploading %s: %w", objectKey, err))
				mu.Unlock()
				return
			}
			mu.Lock()
			manifest.Uploaded[u.relKey] = manifestEntry{Size: fingerprint, ObjectKey: objectKey}
			report.Uploaded++
			if err := savePushManifest(manifestPath, manifest); err != nil && saveErr == nil {
				saveErr = err
			}
			mu.Unlock()
		}()
	}
	wg.Wait()
	return saveErr
}

// snapshotOrSkip decides, for one unit, whether to skip it (its current size
// matches the size recorded in the manifest) or to upload it. On upload it
// returns the payload bytes and the fingerprint to record in the manifest.
//
// For a session JSONL file the size check and the read both happen while
// holding the source's advisory lock, so a hook that appended after collection
// is seen here rather than deferred to the next push, and the snapshot can never
// contain a line another writer is mid-way through. The payload is trimmed to
// its last newline (completeRecords) so a partial trailing record left by a
// crash is never uploaded, and the fingerprint is the size of those uploaded
// bytes — not the full on-disk size, which can include a partial tail. In the
// normal case (file ends in a newline) the two are equal, so an unchanged file
// still skips; when a partial tail is present the file simply re-processes each
// run (idempotent) until the next capture heals it, and a heal that returns the
// file to the same full size can never cause the new complete event to be
// skipped. Legacy per-event files are a single immutable object, uploaded whole.
func snapshotOrSkip(u uploadUnit, recorded int64, known bool) (payload []byte, fingerprint int64, skip bool, err error) {
	unchanged := func(size int64) bool {
		return known && (recorded == legacyUploaded || recorded == size)
	}

	if u.lockPath == "" {
		if unchanged(u.size) {
			return nil, 0, true, nil
		}
		b, readErr := os.ReadFile(u.filePath)
		if readErr != nil {
			return nil, 0, false, fmt.Errorf("reading %s: %w", u.relKey, readErr)
		}
		return b, int64(len(b)), false, nil
	}

	lock, err := acquireLock(u.lockPath)
	if err != nil {
		return nil, 0, false, err
	}
	defer lock.release()

	info, err := os.Stat(u.filePath)
	if err != nil {
		return nil, 0, false, fmt.Errorf("sizing %s: %w", u.relKey, err)
	}
	if unchanged(info.Size()) {
		return nil, 0, true, nil
	}
	b, err := os.ReadFile(u.filePath)
	if err != nil {
		return nil, 0, false, fmt.Errorf("reading %s: %w", u.relKey, err)
	}
	records := completeRecords(b)
	return records, int64(len(records)), false, nil
}

// completeRecords returns the prefix of data up to and including its last
// newline — the whole, newline-terminated records — dropping any partial
// trailing record. It returns nil when data has no newline (no complete record
// yet).
func completeRecords(data []byte) []byte {
	if i := bytes.LastIndexByte(data, '\n'); i >= 0 {
		return data[:i+1]
	}
	return nil
}

// collectUploadUnits lists every uploadable file under both sources: one unit
// per session JSONL file, plus one per legacy per-event JSON file.
func collectUploadUnits(stateDir, eventsBase string) ([]uploadUnit, error) {
	var units []uploadUnit
	for _, src := range []Source{SourceClaude, SourceCodex} {
		sessionsRoot := EventsDir(stateDir, src)
		lockPath := filepath.Join(sessionsRoot, lockFileName)
		entries, err := os.ReadDir(sessionsRoot)
		if err != nil {
			if os.IsNotExist(err) {
				continue
			}
			return nil, fmt.Errorf("reading %s sessions: %w", src, err)
		}
		for _, e := range entries {
			name := e.Name()
			if e.IsDir() {
				dir := filepath.Join(sessionsRoot, name)
				legacy, err := collectLegacyUnits(eventsBase, dir, src, resolveRepoPath(dir))
				if err != nil {
					return nil, err
				}
				units = append(units, legacy...)
				continue
			}
			if !strings.HasSuffix(name, ".jsonl") {
				continue
			}
			filePath := filepath.Join(sessionsRoot, name)
			info, err := e.Info()
			if err != nil {
				return nil, fmt.Errorf("stat %s: %w", filePath, err)
			}
			relKey, err := relSlash(eventsBase, filePath)
			if err != nil {
				return nil, err
			}
			// repoPath is left empty: it is derived from the locked snapshot at
			// upload time so a push racing the first write cannot misfile it.
			units = append(units, uploadUnit{
				relKey:   relKey,
				source:   src,
				filePath: filePath,
				lockPath: lockPath,
				size:     info.Size(),
			})
		}
	}
	return units, nil
}

// collectLegacyUnits lists the per-event JSON files in one legacy session
// directory. These files are immutable, so they upload once (size never
// changes) and need no lock when read.
func collectLegacyUnits(eventsBase, sessionDir string, src Source, repoPath string) ([]uploadUnit, error) {
	entries, err := os.ReadDir(sessionDir)
	if err != nil {
		return nil, fmt.Errorf("reading session dir %s: %w", sessionDir, err)
	}
	names := make([]string, 0, len(entries))
	for _, e := range entries {
		if !e.IsDir() && strings.HasPrefix(e.Name(), "event_") {
			names = append(names, e.Name())
		}
	}
	sort.Strings(names)

	units := make([]uploadUnit, 0, len(names))
	for _, name := range names {
		filePath := filepath.Join(sessionDir, name)
		info, err := os.Stat(filePath)
		if err != nil {
			return nil, fmt.Errorf("stat %s: %w", filePath, err)
		}
		relKey, err := relSlash(eventsBase, filePath)
		if err != nil {
			return nil, err
		}
		units = append(units, uploadUnit{
			relKey:   relKey,
			source:   src,
			repoPath: repoPath,
			filePath: filePath,
			size:     info.Size(),
		})
	}
	return units, nil
}

// relSlash returns target's path relative to base, slash-separated for use as
// an object key and manifest key.
func relSlash(base, target string) (string, error) {
	rel, err := filepath.Rel(base, target)
	if err != nil {
		return "", fmt.Errorf("relativizing %s: %w", target, err)
	}
	return filepath.ToSlash(rel), nil
}

// repoPathFromJSONL returns the repository path for a session, read from its
// JSONL snapshot: the "origin" remote ("host/owner/repo") of the first event
// that recorded one, else the basename of the first event with a repo root,
// else "unknown-repo". Preferring the remote over the basename lets a session
// that straddles the introduction of git.remote still be filed by remote once
// any event carries it. The snapshot is taken under the lock (see
// snapshotOrSkip), so this never sees a partial line.
//
// Lines are read with bufio.Reader.ReadBytes, which grows to fit each line, so
// there is no cap on event size: a large hook payload (stored verbatim in the
// event) still has its git context read rather than falling back to
// "unknown-repo".
func repoPathFromJSONL(data []byte) string {
	r := bufio.NewReader(bytes.NewReader(data))
	basename := ""
	for {
		line, readErr := r.ReadBytes('\n')
		if len(line) > 0 {
			var ev Event
			if json.Unmarshal(line, &ev) == nil && ev.Git != nil {
				if ev.Git.Remote != "" {
					return sanitizeRepoPath(ev.Git.Remote)
				}
				if basename == "" && ev.Git.RepoRoot != "" {
					basename = sanitizeRepoSegment(filepath.Base(ev.Git.RepoRoot))
				}
			}
		}
		if readErr != nil {
			break
		}
	}
	if basename != "" {
		return basename
	}
	return unknownRepoSegment
}

// resolveRepoPath returns the repository path for a legacy session directory,
// read from its event files. Like repoPathFromJSONL it prefers the "origin"
// remote of the first event that recorded one, falling back to the basename of
// the first event with a repo root, then to "unknown-repo".
func resolveRepoPath(sessionDir string) string {
	entries, err := os.ReadDir(sessionDir)
	if err != nil {
		return unknownRepoSegment
	}
	names := make([]string, 0, len(entries))
	for _, e := range entries {
		if !e.IsDir() && strings.HasPrefix(e.Name(), "event_") {
			names = append(names, e.Name())
		}
	}
	sort.Strings(names)
	basename := ""
	for _, name := range names {
		data, err := os.ReadFile(filepath.Join(sessionDir, name))
		if err != nil {
			continue
		}
		var ev Event
		if json.Unmarshal(data, &ev) != nil {
			continue
		}
		if ev.Git != nil {
			if ev.Git.Remote != "" {
				return sanitizeRepoPath(ev.Git.Remote)
			}
			if basename == "" && ev.Git.RepoRoot != "" {
				basename = sanitizeRepoSegment(filepath.Base(ev.Git.RepoRoot))
			}
		}
	}
	if basename != "" {
		return basename
	}
	return unknownRepoSegment
}

// sanitizeRepoPath makes a normalized "host/owner/repo" remote identity safe as
// a multi-segment object-key prefix: it splits on "/", sanitizes each segment
// (dropping "."/".." and empty segments), and rejoins with "/". Slashes are
// preserved so the identity nests as folders in the bucket. Empty input, or
// input that sanitizes away entirely, becomes "unknown-repo".
func sanitizeRepoPath(remote string) string {
	parts := strings.Split(strings.TrimSpace(remote), "/")
	clean := make([]string, 0, len(parts))
	for _, p := range parts {
		p = strings.TrimSpace(p)
		if p == "" || p == "." || p == ".." {
			continue
		}
		clean = append(clean, sanitizeSegmentChars(p))
	}
	if len(clean) == 0 {
		return unknownRepoSegment
	}
	return strings.Join(clean, "/")
}

// sanitizeRepoSegment makes a repository basename safe as a single object-key
// segment. Empty input becomes "unknown-repo".
func sanitizeRepoSegment(name string) string {
	name = strings.TrimSpace(name)
	if name == "" || name == "." || name == ".." {
		return unknownRepoSegment
	}
	return sanitizeSegmentChars(name)
}

// sanitizeSegmentChars replaces, within a single object-key segment, the
// characters that cannot safely appear there: path separators, a colon (a
// legal object-key byte but an illegal filename byte on Windows, where
// beta:fetch recreates the key tree on disk), whitespace, and the URL
// delimiters the upload endpoint rejects.
func sanitizeSegmentChars(s string) string {
	return strings.Map(func(r rune) rune {
		switch r {
		case '/', '\\', ':', ' ', '\t', '\n', '\r', '?', '#', '%':
			return '-'
		}
		return r
	}, s)
}

// loadPushManifest reads the manifest, returning an empty one when the file
// does not yet exist.
func loadPushManifest(path string) (*pushManifest, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return &pushManifest{Uploaded: map[string]manifestEntry{}}, nil
		}
		return nil, fmt.Errorf("reading push manifest %s: %w", path, err)
	}
	var m pushManifest
	if err := json.Unmarshal(data, &m); err != nil {
		return nil, fmt.Errorf("parsing push manifest %s: %w", path, err)
	}
	if m.Uploaded == nil {
		m.Uploaded = map[string]manifestEntry{}
	}
	return &m, nil
}

// savePushManifest writes the manifest atomically (write-then-rename) so an
// interrupted write cannot corrupt the existing manifest.
func savePushManifest(path string, m *pushManifest) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return fmt.Errorf("creating manifest dir: %w", err)
	}
	data, err := json.MarshalIndent(m, "", "  ")
	if err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return fmt.Errorf("writing push manifest: %w", err)
	}
	if err := os.Rename(tmp, path); err != nil {
		return fmt.Errorf("replacing push manifest: %w", err)
	}
	return nil
}

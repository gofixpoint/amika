package eventlog

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// memoryManifestName is the file under <state>/events that records the
// last-synced content hash of each uploaded memory file, kept separate from the
// session push manifest because memory files are edited in place (so they are
// tracked by content hash, not by the monotonically growing size that the
// append-only session manifest assumes).
const memoryManifestName = ".amikalog-memory-push-state.json"

// memorySegment is the object-key segment under a repository prefix that holds
// that repository's memory files, mirroring the "sessions" segment used for
// captured events.
const memorySegment = "memory"

// mergeTimeout bounds a single claude merge invocation.
const mergeTimeout = 5 * time.Minute

// ErrMergerUnavailable is returned by a Merger when the backing coding agent is
// not available (e.g. the claude CLI is not installed on this host). PushMemories
// treats it as a reason to skip the file with a warning rather than fail the run,
// so a machine without claude still uploads non-diverged memory files.
var ErrMergerUnavailable = errors.New("merger unavailable")

// Merger reconciles a memory file that changed on both this machine and in the
// cloud into a single merged document. Implementations should preserve every
// distinct fact from both sides; PushMemories writes the result back to the
// local file and uploads it.
type Merger interface {
	Merge(local, cloud []byte) ([]byte, error)
}

// MemoryPushReport summarizes a PushMemories run.
type MemoryPushReport struct {
	// Uploaded is the number of memory files sent to the bucket because they were
	// new or changed only locally since the last sync.
	Uploaded int
	// Merged is the number of memory files that had diverged on both sides and
	// were reconciled by the Merger, then written back locally and uploaded.
	Merged int
	// Pulled is the number of memory files that changed only in the cloud and
	// were written back to the local file (not uploaded).
	Pulled int
	// Skipped is the number of memory files already in sync (or skipped because
	// a merge was needed but the Merger was unavailable).
	Skipped int
	// Failed is the number of memory files whose reconciliation returned an error.
	Failed int
	// Warnings holds non-fatal messages (e.g. a merge skipped because claude is
	// not installed).
	Warnings []string
	// Errors holds one error per failed file (parallel to Failed).
	Errors []error
}

// memoryEntry records what was last synced for one memory file.
type memoryEntry struct {
	// ObjectKey is the destination bucket key, pinned so it never changes.
	ObjectKey string `json:"object_key"`
	// SyncedHash is the sha256 (hex) of the content as of the last successful
	// sync. It is the base for 3-way divergence detection: if the cloud copy
	// still hashes to this, the cloud is unchanged since we last synced and the
	// local copy can be uploaded; if it differs, both sides changed.
	SyncedHash string `json:"synced_hash"`
}

// memoryManifest tracks synced memory files keyed by their object key.
type memoryManifest struct {
	Synced map[string]memoryEntry `json:"synced"`
}

// memoryUnit is one memory file PushMemories may reconcile.
type memoryUnit struct {
	// filePath is the absolute on-disk path of the memory file.
	filePath string
	// objectKey is the destination bucket key, lowercased.
	objectKey string
}

// memoryOutcome is the result of reconciling one memory file.
type memoryOutcome int

const (
	outcomeSkipped memoryOutcome = iota
	outcomeUploaded
	outcomePulled
	outcomeMerged
)

// claudeProjectDirName returns the directory name Claude Code uses for a project
// working directory under ~/.claude/projects. Claude Code derives it by
// replacing every character that is not an ASCII letter or digit with '-', so
// "/home/u/my.app" becomes "-home-u-my-app". The mapping is lossy (a path
// containing '-' or '.' cannot be reversed unambiguously), but we only ever go
// cwd -> name, which is deterministic.
func claudeProjectDirName(cwd string) string {
	return strings.Map(func(r rune) rune {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9':
			return r
		default:
			return '-'
		}
	}, cwd)
}

// PushMemories uploads Claude memory files, reconciling each against its cloud
// copy so an in-place edit on this machine never clobbers an edit made elsewhere.
//
// By default only the projects amikalog has captured Claude sessions for are
// considered, so each file's repository prefix comes from its session. When
// allProjects is true every ~/.claude/projects/*/memory directory is scanned,
// including projects with no captured session; the repository prefix for those
// is recovered from the project's own Claude transcript working directory (and
// the git repo there), falling back to "unknown-repo".
//
// A memory file lives at ~/.claude/projects/<project>/memory/*.md and its object
// key is "<repo>/memory/<relpath>". For each file PushMemories compares the local
// content, the cloud content, and the last-synced hash recorded in a dedicated
// manifest:
//   - no cloud copy        -> upload local
//   - identical            -> skip
//   - only local changed   -> upload local
//   - only cloud changed   -> pull (write cloud to the local file)
//   - both changed         -> merge with the Merger, write back, and upload
//
// The run-wide push lock is held for the duration (the same lock Push takes), so
// concurrent pushes cannot interleave overwrites. Per-file failures are recorded
// in the report and do not abort the run.
func PushMemories(stateDir, home string, allProjects bool, up Uploader, down Downloader, merger Merger) (MemoryPushReport, error) {
	eventsBase := filepath.Join(stateDir, "events")
	if err := os.MkdirAll(eventsBase, 0o755); err != nil {
		return MemoryPushReport{}, fmt.Errorf("creating events dir %s: %w", eventsBase, err)
	}

	lock, err := acquireLock(filepath.Join(eventsBase, pushLockName))
	if err != nil {
		return MemoryPushReport{}, err
	}
	defer lock.release()

	manifestPath := filepath.Join(eventsBase, memoryManifestName)
	manifest, err := loadMemoryManifest(manifestPath)
	if err != nil {
		return MemoryPushReport{}, err
	}

	units, err := collectMemoryUnits(stateDir, home, allProjects)
	if err != nil {
		return MemoryPushReport{}, err
	}

	var report MemoryPushReport
	for _, u := range units {
		outcome, rerr := reconcileMemory(u, manifest, up, down, merger)
		if rerr != nil {
			if errors.Is(rerr, ErrMergerUnavailable) {
				report.Skipped++
				report.Warnings = append(report.Warnings, fmt.Sprintf("%s: %v", u.objectKey, rerr))
				continue
			}
			report.Failed++
			report.Errors = append(report.Errors, rerr)
			continue
		}
		switch outcome {
		case outcomeUploaded:
			report.Uploaded++
		case outcomeMerged:
			report.Merged++
		case outcomePulled:
			report.Pulled++
		default:
			report.Skipped++
		}
		// Persist after every reconciled file so an interrupted run (e.g. a slow
		// merge that is killed) resumes without re-doing completed work.
		if err := saveMemoryManifest(manifestPath, manifest); err != nil {
			return report, err
		}
	}
	return report, nil
}

// collectMemoryUnits lists the memory files to reconcile: one per *.md file in
// a project's memory directory. By default only projects amikalog has captured a
// Claude session for are scanned, each keyed under the repository prefix from its
// sessions so a repo's memory lands alongside its events under the same "<repo>/"
// key. When allProjects is true every ~/.claude/projects/*/memory directory is
// scanned; a project with no captured session has its repository prefix recovered
// from its own Claude transcript (see repoSegmentForProjectDir).
func collectMemoryUnits(stateDir, home string, allProjects bool) ([]memoryUnit, error) {
	projectsRoot := filepath.Join(home, ".claude", "projects")

	// Seed each captured project directory with its repository segment, derived
	// from amikalog's own session capture.
	repoByProjectDir, err := trackedProjectRepoSegments(stateDir)
	if err != nil {
		return nil, err
	}

	// Decide which project directories to scan.
	var projectDirs []string
	if allProjects {
		entries, err := os.ReadDir(projectsRoot)
		if err != nil {
			if os.IsNotExist(err) {
				return nil, nil
			}
			return nil, fmt.Errorf("reading claude projects: %w", err)
		}
		for _, e := range entries {
			if e.IsDir() {
				projectDirs = append(projectDirs, e.Name())
			}
		}
	} else {
		for dir := range repoByProjectDir {
			projectDirs = append(projectDirs, dir)
		}
	}
	sort.Strings(projectDirs)

	var units []memoryUnit
	seen := map[string]bool{}
	for _, dir := range projectDirs {
		projectDir := filepath.Join(projectsRoot, dir)
		repoSeg, ok := repoByProjectDir[dir]
		if !ok {
			// Untracked project (allProjects only): recover its repository from
			// the project's own Claude transcript.
			repoSeg = repoSegmentForProjectDir(projectDir)
		}
		memoryDir := filepath.Join(projectDir, "memory")
		walkErr := filepath.WalkDir(memoryDir, func(p string, d fs.DirEntry, err error) error {
			if err != nil {
				// The memory directory simply may not exist for this project.
				if os.IsNotExist(err) {
					return fs.SkipAll
				}
				return err
			}
			if d.IsDir() || !strings.HasSuffix(strings.ToLower(d.Name()), ".md") {
				return nil
			}
			rel, err := relSlash(memoryDir, p)
			if err != nil {
				return err
			}
			objectKey := strings.ToLower(path.Join(repoSeg, memorySegment, rel))
			// Distinct projects can map to the same repo segment (e.g. a repo and
			// a subdirectory of it); the first occurrence of a key wins.
			if seen[objectKey] {
				return nil
			}
			seen[objectKey] = true
			units = append(units, memoryUnit{filePath: p, objectKey: objectKey})
			return nil
		})
		if walkErr != nil {
			return nil, fmt.Errorf("scanning memory dir %s: %w", memoryDir, walkErr)
		}
	}
	return units, nil
}

// trackedProjectRepoSegments maps each Claude project directory name amikalog has
// captured a session for to that project's repository segment, read from the
// session's working directory and git context.
func trackedProjectRepoSegments(stateDir string) (map[string]string, error) {
	repoByProjectDir := map[string]string{}
	sessionsRoot := EventsDir(stateDir, SourceClaude)
	entries, err := os.ReadDir(sessionsRoot)
	if err != nil {
		if os.IsNotExist(err) {
			return repoByProjectDir, nil
		}
		return nil, fmt.Errorf("reading claude sessions: %w", err)
	}
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".jsonl") {
			continue
		}
		data, err := os.ReadFile(filepath.Join(sessionsRoot, e.Name()))
		if err != nil {
			return nil, fmt.Errorf("reading %s: %w", e.Name(), err)
		}
		cwd := cwdFromJSONL(data)
		if cwd == "" {
			continue
		}
		dir := claudeProjectDirName(cwd)
		if _, ok := repoByProjectDir[dir]; !ok {
			repoByProjectDir[dir] = repoSegmentFromJSONL(data)
		}
	}
	return repoByProjectDir, nil
}

// repoSegmentForProjectDir recovers a repository segment for an untracked Claude
// project directory: it reads the working directory from the project's own Claude
// transcript and inspects that directory's git repository. It returns
// "unknown-repo" when there is no transcript cwd or the directory is not a repo.
func repoSegmentForProjectDir(projectDir string) string {
	cwd := cwdFromClaudeTranscripts(projectDir)
	if cwd == "" {
		return unknownRepoSegment
	}
	if git := GatherGit(cwd); git != nil && git.RepoRoot != "" {
		return sanitizeRepoSegment(filepath.Base(git.RepoRoot))
	}
	return unknownRepoSegment
}

// cwdFromClaudeTranscripts returns the working directory recorded in a project's
// Claude Code transcript (the *.jsonl files Claude writes directly under the
// project directory), or "" when none is found. Claude's transcript lines carry
// a top-level "cwd" field, so cwdFromJSONL (which reads Event.CWD, tagged "cwd")
// extracts it without needing the full Event shape.
func cwdFromClaudeTranscripts(projectDir string) string {
	entries, err := os.ReadDir(projectDir)
	if err != nil {
		return ""
	}
	names := make([]string, 0, len(entries))
	for _, e := range entries {
		if !e.IsDir() && strings.HasSuffix(e.Name(), ".jsonl") {
			names = append(names, e.Name())
		}
	}
	sort.Strings(names)
	for _, name := range names {
		data, err := os.ReadFile(filepath.Join(projectDir, name))
		if err != nil {
			continue
		}
		if cwd := cwdFromJSONL(data); cwd != "" {
			return cwd
		}
	}
	return ""
}

// reconcileMemory reconciles one memory file against its cloud copy using the
// last-synced hash in manifest, mutating manifest on success. See PushMemories
// for the decision table.
func reconcileMemory(u memoryUnit, manifest *memoryManifest, up Uploader, down Downloader, merger Merger) (memoryOutcome, error) {
	localBytes, err := os.ReadFile(u.filePath)
	if err != nil {
		return outcomeSkipped, fmt.Errorf("reading %s: %w", u.filePath, err)
	}
	localHash := hashBytes(localBytes)
	entry, known := manifest.Synced[u.objectKey]

	cloudBytes, cloudExists, err := down.Fetch(u.objectKey)
	if err != nil {
		return outcomeSkipped, fmt.Errorf("fetching %s: %w", u.objectKey, err)
	}

	// No cloud copy yet: upload local as the initial version.
	if !cloudExists {
		if err := up.Upload(u.objectKey, localBytes); err != nil {
			return outcomeSkipped, fmt.Errorf("uploading %s: %w", u.objectKey, err)
		}
		manifest.Synced[u.objectKey] = memoryEntry{ObjectKey: u.objectKey, SyncedHash: localHash}
		return outcomeUploaded, nil
	}

	cloudHash := hashBytes(cloudBytes)

	// Identical: nothing to send. Refresh the manifest so a first sync after the
	// content already matched still records the base for future runs.
	if cloudHash == localHash {
		if !known || entry.SyncedHash != localHash {
			manifest.Synced[u.objectKey] = memoryEntry{ObjectKey: u.objectKey, SyncedHash: localHash}
		}
		return outcomeSkipped, nil
	}

	// Cloud unchanged since our last sync: local is the only change -> upload it.
	if known && entry.SyncedHash == cloudHash {
		if err := up.Upload(u.objectKey, localBytes); err != nil {
			return outcomeSkipped, fmt.Errorf("uploading %s: %w", u.objectKey, err)
		}
		manifest.Synced[u.objectKey] = memoryEntry{ObjectKey: u.objectKey, SyncedHash: localHash}
		return outcomeUploaded, nil
	}

	// Local unchanged since our last sync: only the cloud changed -> pull it down.
	if known && entry.SyncedHash == localHash {
		if err := writeFileAtomic(u.filePath, cloudBytes); err != nil {
			return outcomeSkipped, fmt.Errorf("writing %s: %w", u.filePath, err)
		}
		manifest.Synced[u.objectKey] = memoryEntry{ObjectKey: u.objectKey, SyncedHash: cloudHash}
		return outcomePulled, nil
	}

	// Both sides changed (or this is the first sync against a pre-existing cloud
	// copy): merge with the coding agent, then converge both sides. On any merge
	// failure neither side is touched, so a bad merge can never clobber data.
	merged, err := merger.Merge(localBytes, cloudBytes)
	if err != nil {
		return outcomeSkipped, fmt.Errorf("merging %s: %w", u.objectKey, err)
	}
	if err := writeFileAtomic(u.filePath, merged); err != nil {
		return outcomeSkipped, fmt.Errorf("writing merged %s: %w", u.filePath, err)
	}
	if err := up.Upload(u.objectKey, merged); err != nil {
		return outcomeSkipped, fmt.Errorf("uploading merged %s: %w", u.objectKey, err)
	}
	manifest.Synced[u.objectKey] = memoryEntry{ObjectKey: u.objectKey, SyncedHash: hashBytes(merged)}
	return outcomeMerged, nil
}

// hashBytes returns the hex-encoded sha256 of b, used as a memory file's content
// fingerprint.
func hashBytes(b []byte) string {
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}

// loadMemoryManifest reads the memory push manifest, returning an empty one when
// the file does not yet exist.
func loadMemoryManifest(path string) (*memoryManifest, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return &memoryManifest{Synced: map[string]memoryEntry{}}, nil
		}
		return nil, fmt.Errorf("reading memory push manifest %s: %w", path, err)
	}
	var m memoryManifest
	if err := json.Unmarshal(data, &m); err != nil {
		return nil, fmt.Errorf("parsing memory push manifest %s: %w", path, err)
	}
	if m.Synced == nil {
		m.Synced = map[string]memoryEntry{}
	}
	return &m, nil
}

// saveMemoryManifest writes the manifest atomically (write-then-rename) so an
// interrupted write cannot corrupt the existing manifest.
func saveMemoryManifest(path string, m *memoryManifest) error {
	data, err := json.MarshalIndent(m, "", "  ")
	if err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return fmt.Errorf("writing memory push manifest: %w", err)
	}
	if err := os.Rename(tmp, path); err != nil {
		return fmt.Errorf("replacing memory push manifest: %w", err)
	}
	return nil
}

// claudeMerger merges two versions of a memory file by invoking the locally
// installed claude CLI in one-shot print mode.
type claudeMerger struct{}

// NewClaudeMerger returns a Merger backed by the host claude CLI. It returns
// ErrMergerUnavailable from Merge when the claude binary is not on PATH.
func NewClaudeMerger() Merger { return claudeMerger{} }

// Merge runs `claude -p <prompt> --output-format json` with both versions
// embedded in the prompt and returns the reconciled file content. It requires
// the claude CLI on PATH (ErrMergerUnavailable otherwise) and asks the model to
// emit only the merged file content.
func (claudeMerger) Merge(local, cloud []byte) ([]byte, error) {
	exe, err := exec.LookPath("claude")
	if err != nil {
		return nil, fmt.Errorf("%w: claude CLI not found on PATH", ErrMergerUnavailable)
	}

	ctx, cancel := context.WithTimeout(context.Background(), mergeTimeout)
	defer cancel()

	cmd := exec.CommandContext(ctx, exe, "-p", buildMergePrompt(local, cloud),
		"--output-format", "json", "--dangerously-skip-permissions")
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		return nil, fmt.Errorf("running claude merge: %w (stderr: %s)", err, strings.TrimSpace(stderr.String()))
	}

	var out struct {
		Result  string `json:"result"`
		IsError bool   `json:"is_error"`
	}
	if err := json.Unmarshal(stdout.Bytes(), &out); err != nil {
		return nil, fmt.Errorf("parsing claude output: %w", err)
	}
	if out.IsError {
		return nil, fmt.Errorf("claude reported a merge error: %s", strings.TrimSpace(out.Result))
	}
	merged := strings.TrimSpace(out.Result)
	if merged == "" {
		return nil, fmt.Errorf("claude returned an empty merge result")
	}
	return []byte(merged + "\n"), nil
}

// buildMergePrompt constructs the one-shot prompt instructing the agent to
// reconcile the two versions into a single markdown document.
func buildMergePrompt(local, cloud []byte) string {
	var b strings.Builder
	b.WriteString("You are merging two versions of a Markdown memory file that have diverged. ")
	b.WriteString("Produce a single reconciled version that preserves every distinct fact from BOTH versions, ")
	b.WriteString("removes exact duplicates, and keeps one valid YAML frontmatter block if either version has one. ")
	b.WriteString("Do not invent new facts. Output ONLY the merged file content, with no commentary, no explanation, and no code fences.\n\n")
	b.WriteString("===== VERSION A (local) =====\n")
	b.Write(local)
	b.WriteString("\n===== VERSION B (cloud) =====\n")
	b.Write(cloud)
	b.WriteString("\n===== END =====\n")
	return b.String()
}

package sessioncapture

import (
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

// The metadata sidecar records, per turn, the git state the work happened on
// and the tool calls that turn made. It sits next to the mirrored transcript
// as `<stem>.meta.json`. Capturing the commit at every turn is the only way
// to see mid-session branch/commit switches: git only knows its current HEAD,
// so a turn's commit can't be recovered after the fact — it has to be recorded
// as each turn completes. Captures therefore accumulate across hook fires.

// gitInfo is the git state observed in a session's working directory at the
// moment a turn completed. Nil when the working directory isn't a git repo.
type gitInfo struct {
	Commit string `json:"commit"`
	Branch string `json:"branch"`
	Dirty  bool   `json:"dirty"`
}

// repoInfo identifies the repository a session's work happened in.
type repoInfo struct {
	RemoteURL string `json:"remote_url,omitempty"`
	Root      string `json:"root,omitempty"`
}

// toolCall is a single tool invocation made during a turn, with its full
// input arguments preserved verbatim.
type toolCall struct {
	Name  string          `json:"name"`
	ID    string          `json:"id,omitempty"`
	Input json.RawMessage `json:"input,omitempty"`
}

// captureRecord is one turn's worth of metadata: when the turn was captured,
// the git state at that point, and the tool calls the turn made.
type captureRecord struct {
	Timestamp string     `json:"ts"`
	Git       *gitInfo   `json:"git,omitempty"`
	Tools     []toolCall `json:"tools"`
}

// sessionMeta is the full sidecar document for one session.
type sessionMeta struct {
	Source    Source          `json:"source"`
	SessionID string          `json:"session_id,omitempty"`
	Repo      *repoInfo       `json:"repo,omitempty"`
	Captures  []captureRecord `json:"captures"`
	// TranscriptLines is how many transcript lines have already been folded
	// into Captures. It is the cursor that lets each turn's tool calls be
	// sliced off the append-only transcript without re-recording earlier
	// turns. Claude only.
	TranscriptLines int `json:"transcript_lines,omitempty"`
}

// nowFunc and resolveGitState are indirected so tests can pin the timestamp
// and stub git resolution without standing up a real repository.
var (
	nowFunc         = time.Now
	resolveGitState = gitStateFromCmd
)

// metaPathFor returns the sidecar path for a mirrored transcript: the same
// path with its `.jsonl` suffix replaced by `.meta.json`.
func metaPathFor(transcriptDst string) string {
	return strings.TrimSuffix(transcriptDst, ".jsonl") + ".meta.json"
}

// updateClaudeMeta folds the turn(s) appended to the transcript since the last
// capture into the sidecar at metaPath: it parses the new transcript lines for
// tool calls, resolves the current git state in the session's working
// directory, and appends one capture record. Re-reading the whole transcript
// each time would re-record earlier turns, so it resumes from the stored line
// cursor.
func updateClaudeMeta(metaPath string, in claudeStopHookInput) error {
	meta, err := loadMeta(metaPath)
	if err != nil {
		return err
	}
	meta.Source = SourceClaude
	if in.SessionID != "" {
		meta.SessionID = in.SessionID
	}

	lines, err := readLines(in.TranscriptPath)
	if err != nil {
		return err
	}
	// If the transcript shrank (rotation, truncation) the cursor is stale;
	// reparse from the top rather than slicing out of range.
	start := meta.TranscriptLines
	if start > len(lines) {
		start = 0
	}
	tools, cwd := parseClaudeTurn(lines[start:])
	if cwd == "" {
		cwd = lastClaudeCwd(lines)
	}
	if cwd == "" {
		cwd = in.Cwd
	}

	git, repo := resolveGitState(cwd)
	if repo != nil {
		meta.Repo = repo
	}
	meta.Captures = append(meta.Captures, captureRecord{
		Timestamp: nowFunc().UTC().Format(time.RFC3339),
		Git:       git,
		Tools:     tools,
	})
	meta.TranscriptLines = len(lines)
	return writeMeta(metaPath, meta)
}

// claudeEntry is the subset of a Claude transcript line we read: its type, the
// working directory it ran in, and the message content (which may be a string
// or a content-block array, hence RawMessage).
type claudeEntry struct {
	Type    string `json:"type"`
	Cwd     string `json:"cwd"`
	Message struct {
		Content json.RawMessage `json:"content"`
	} `json:"message"`
}

// claudeBlock is one content block within an assistant message.
type claudeBlock struct {
	Type  string          `json:"type"`
	ID    string          `json:"id"`
	Name  string          `json:"name"`
	Input json.RawMessage `json:"input"`
}

// parseClaudeTurn extracts the tool calls from a slice of transcript lines and
// returns them along with the last working directory seen in those lines.
// Malformed lines are skipped so a single bad record can't drop a turn.
func parseClaudeTurn(lines []string) ([]toolCall, string) {
	var tools []toolCall
	var cwd string
	for _, line := range lines {
		if strings.TrimSpace(line) == "" {
			continue
		}
		var e claudeEntry
		if err := json.Unmarshal([]byte(line), &e); err != nil {
			continue
		}
		if e.Cwd != "" {
			cwd = e.Cwd
		}
		var blocks []claudeBlock
		if err := json.Unmarshal(e.Message.Content, &blocks); err != nil {
			continue // content was a plain string (e.g. a user line)
		}
		for _, b := range blocks {
			if b.Type != "tool_use" {
				continue
			}
			tools = append(tools, toolCall{Name: b.Name, ID: b.ID, Input: b.Input})
		}
	}
	return tools, cwd
}

// lastClaudeCwd returns the working directory of the last transcript line that
// records one, used when the current turn's new lines carry no cwd.
func lastClaudeCwd(lines []string) string {
	for i := len(lines) - 1; i >= 0; i-- {
		var e claudeEntry
		if err := json.Unmarshal([]byte(lines[i]), &e); err != nil {
			continue
		}
		if e.Cwd != "" {
			return e.Cwd
		}
	}
	return ""
}

// gitStateFromCmd resolves the git state of cwd by shelling out to git.
// Returns (nil, nil) when cwd is empty or not inside a git work tree; other
// per-field failures degrade gracefully to empty values.
func gitStateFromCmd(cwd string) (*gitInfo, *repoInfo) {
	if cwd == "" {
		return nil, nil
	}
	root, err := gitOutput(cwd, "rev-parse", "--show-toplevel")
	if err != nil {
		return nil, nil // not a git repo (or git unavailable)
	}
	commit, _ := gitOutput(cwd, "rev-parse", "HEAD")
	branch, _ := gitOutput(cwd, "rev-parse", "--abbrev-ref", "HEAD")
	status, _ := gitOutput(cwd, "status", "--porcelain")
	remote, _ := gitOutput(cwd, "remote", "get-url", "origin")
	return &gitInfo{
			Commit: commit,
			Branch: branch,
			Dirty:  strings.TrimSpace(status) != "",
		}, &repoInfo{
			RemoteURL: remote,
			Root:      root,
		}
}

func gitOutput(cwd string, args ...string) (string, error) {
	cmd := exec.Command("git", args...)
	cmd.Dir = cwd
	out, err := cmd.Output()
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(out)), nil
}

// readLines reads a file and splits it into lines, dropping a trailing empty
// element so a final newline doesn't yield a phantom line.
func readLines(path string) ([]string, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	if len(data) == 0 {
		return nil, nil
	}
	lines := strings.Split(string(data), "\n")
	if len(lines) > 0 && lines[len(lines)-1] == "" {
		lines = lines[:len(lines)-1]
	}
	return lines, nil
}

// loadMeta reads an existing sidecar, returning a zero-value sessionMeta when
// none exists yet.
func loadMeta(path string) (sessionMeta, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return sessionMeta{}, nil
		}
		return sessionMeta{}, err
	}
	var meta sessionMeta
	if len(strings.TrimSpace(string(data))) == 0 {
		return sessionMeta{}, nil
	}
	if err := json.Unmarshal(data, &meta); err != nil {
		return sessionMeta{}, err
	}
	return meta, nil
}

// writeMeta atomically writes the sidecar as indented JSON.
func writeMeta(path string, meta sessionMeta) error {
	encoded, err := json.MarshalIndent(meta, "", "  ")
	if err != nil {
		return err
	}
	encoded = append(encoded, '\n')
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	return writeFileAtomic(path, encoded)
}

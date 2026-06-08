package sessioncapture

import (
	"encoding/json"
	"strings"
)

// Codex metadata is best-effort and weaker than Claude's. Codex's notify hook
// hands us no session path or working directory, so capture walks the whole
// tree (see CaptureCodex) rather than reacting to a single turn — there is no
// reliable per-turn signal to hang a git observation on. So instead of the
// per-turn timeline we build for Claude, the Codex sidecar is rebuilt in full
// from the rollout on each refresh: the git state recorded in the rollout's
// session-meta header (set when the session started) plus every tool call the
// rollout contains, collapsed into a single capture record. Mid-session branch
// switches are therefore not tracked for Codex.

// codexLine is the envelope shape of a Codex rollout JSONL record. Older
// rollouts inline the fields with no `payload` wrapper, so callers fall back to
// treating the whole line as the payload when Payload is absent.
type codexLine struct {
	Type    string          `json:"type"`
	Payload json.RawMessage `json:"payload"`
}

// codexSessionMeta is the subset of a `session_meta` payload we read.
type codexSessionMeta struct {
	Cwd string    `json:"cwd"`
	Git *codexGit `json:"git"`
}

type codexGit struct {
	CommitHash    string `json:"commit_hash"`
	Branch        string `json:"branch"`
	RepositoryURL string `json:"repository_url"`
}

// codexResponseItem is the subset of a response-item payload we read: function
// calls carry the tool name, a call id, and JSON-encoded arguments.
type codexResponseItem struct {
	Type      string          `json:"type"`
	Name      string          `json:"name"`
	CallID    string          `json:"call_id"`
	Arguments json.RawMessage `json:"arguments"`
}

// updateCodexMeta rebuilds the sidecar at metaPath from the Codex rollout at
// rolloutPath. Best-effort: unrecognized or malformed lines are skipped.
func updateCodexMeta(metaPath, rolloutPath string) error {
	lines, err := readLines(rolloutPath)
	if err != nil {
		return err
	}

	meta := sessionMeta{
		Source:    SourceCodex,
		SessionID: sessionIDFromPath(rolloutPath),
	}
	var cwd string
	var recordedGit *codexGit
	var tools []toolCall

	for _, line := range lines {
		if strings.TrimSpace(line) == "" {
			continue
		}
		var env codexLine
		if err := json.Unmarshal([]byte(line), &env); err != nil {
			continue
		}
		// Inline rollouts have no payload wrapper; fall back to the line.
		payload := env.Payload
		if len(payload) == 0 {
			payload = json.RawMessage(line)
		}

		switch env.Type {
		case "session_meta":
			var sm codexSessionMeta
			if err := json.Unmarshal(payload, &sm); err == nil {
				if sm.Cwd != "" {
					cwd = sm.Cwd
				}
				if sm.Git != nil {
					recordedGit = sm.Git
				}
			}
		default:
			var item codexResponseItem
			if err := json.Unmarshal(payload, &item); err != nil {
				continue
			}
			if item.Type == "function_call" || item.Type == "local_shell_call" {
				tools = append(tools, toolCall{
					Name:  item.Name,
					ID:    item.CallID,
					Input: normalizeCodexArgs(item.Arguments),
				})
			}
		}
	}

	git, repo := codexGitState(recordedGit, cwd)
	if repo != nil {
		meta.Repo = repo
	}
	meta.Captures = []captureRecord{{
		Timestamp: nowFunc().UTC().Format("2006-01-02T15:04:05Z07:00"),
		Git:       git,
		Tools:     tools,
	}}
	return writeMeta(metaPath, meta)
}

// codexGitState prefers the git state recorded in the rollout header. When the
// rollout carries none, it falls back to resolving git live in the recorded
// cwd (consistent with the Claude path).
func codexGitState(recorded *codexGit, cwd string) (*gitInfo, *repoInfo) {
	if recorded != nil {
		var repo *repoInfo
		if recorded.RepositoryURL != "" {
			repo = &repoInfo{RemoteURL: recorded.RepositoryURL}
		}
		return &gitInfo{Commit: recorded.CommitHash, Branch: recorded.Branch}, repo
	}
	return resolveGitState(cwd)
}

// normalizeCodexArgs unwraps Codex's JSON-string-encoded arguments into the
// embedded JSON value when possible, so the sidecar stores `{"command":...}`
// rather than an escaped string. Non-string or non-JSON values pass through
// unchanged.
func normalizeCodexArgs(raw json.RawMessage) json.RawMessage {
	if len(raw) == 0 || raw[0] != '"' {
		return raw
	}
	var s string
	if err := json.Unmarshal(raw, &s); err != nil {
		return raw
	}
	if json.Valid([]byte(s)) {
		return json.RawMessage(s)
	}
	return raw
}

// sessionIDFromPath derives a session id from a rollout filename by stripping
// its `.jsonl` extension.
func sessionIDFromPath(path string) string {
	base := path
	if i := strings.LastIndexAny(base, "/\\"); i >= 0 {
		base = base[i+1:]
	}
	return strings.TrimSuffix(base, ".jsonl")
}

package appcfg

import (
	"bytes"
	"encoding/json"
	"fmt"

	"github.com/gofixpoint/amika/go/internal/basedir"
)

// ClaudeSSHHost describes an SSH environment to register in Claude Desktop's
// settings under `sshConfigs`. SSHHost is a ~/.ssh/config Host alias (the
// Amika-managed `amika-<id>`), so port/user/auth come from the SSH config
// rather than being duplicated here.
type ClaudeSSHHost struct {
	ID             string
	Name           string
	SSHHost        string
	StartDirectory string
}

// claudeSSHConfigEntry is the on-disk JSON shape of a Claude `sshConfigs` entry.
// Only the fields Amika manages are modeled; the entry is fully owned by Amika
// (keyed by its `id`), so re-marshaling it is lossless for our purposes.
type claudeSSHConfigEntry struct {
	ID             string `json:"id"`
	Name           string `json:"name"`
	SSHHost        string `json:"sshHost"`
	StartDirectory string `json:"startDirectory,omitempty"`
}

func (h ClaudeSSHHost) entry() claudeSSHConfigEntry {
	return claudeSSHConfigEntry{
		ID:             h.ID,
		Name:           h.Name,
		SSHHost:        h.SSHHost,
		StartDirectory: h.StartDirectory,
	}
}

// UpsertClaudeSSHConfig adds or updates an SSH environment in
// ~/.claude/settings.json. Every other setting in the file is preserved, as are
// all other `sshConfigs` entries (including any fields Amika does not model);
// only the entry whose `id` matches host.ID is replaced. It reports whether the
// file was changed, so callers can stay quiet when the environment is already
// registered. A missing settings file is created.
func UpsertClaudeSSHConfig(paths basedir.Paths, host ClaudeSSHHost) (bool, error) {
	path, err := paths.ClaudeSettingsFile()
	if err != nil {
		return false, err
	}
	raw, err := readFileOrEmpty(path)
	if err != nil {
		return false, fmt.Errorf("read %s: %w", path, err)
	}

	// Preserve every top-level key by decoding into raw messages and only
	// touching `sshConfigs`.
	doc := map[string]json.RawMessage{}
	if len(bytes.TrimSpace(raw)) > 0 {
		if err := json.Unmarshal(raw, &doc); err != nil {
			return false, fmt.Errorf("parse %s (is it valid JSON?): %w", path, err)
		}
	}

	// Preserve unknown fields on other entries by keeping them as raw messages.
	var entries []json.RawMessage
	if existing, ok := doc["sshConfigs"]; ok && len(bytes.TrimSpace(existing)) > 0 {
		if err := json.Unmarshal(existing, &entries); err != nil {
			return false, fmt.Errorf("parse sshConfigs in %s: %w", path, err)
		}
	}

	desired := host.entry()
	desiredRaw, err := json.Marshal(desired)
	if err != nil {
		return false, err
	}

	found := false
	for i, e := range entries {
		var probe struct {
			ID string `json:"id"`
		}
		if err := json.Unmarshal(e, &probe); err != nil {
			continue
		}
		if probe.ID != host.ID {
			continue
		}
		found = true
		// Already registered identically: nothing to do.
		var current claudeSSHConfigEntry
		if json.Unmarshal(e, &current) == nil && current == desired {
			return false, nil
		}
		entries[i] = desiredRaw
		break
	}
	if !found {
		entries = append(entries, desiredRaw)
	}

	newList, err := json.Marshal(entries)
	if err != nil {
		return false, err
	}
	doc["sshConfigs"] = newList

	out, err := json.MarshalIndent(doc, "", "  ")
	if err != nil {
		return false, err
	}
	out = append(out, '\n')
	if err := writeFileAtomic(path, out); err != nil {
		return false, err
	}
	return true, nil
}

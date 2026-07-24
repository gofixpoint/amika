package appcfg

import (
	"bytes"
	"fmt"

	"github.com/BurntSushi/toml"
	"github.com/gofixpoint/amika/go/internal/basedir"
)

// EnableCodexRemoteConnections ensures ~/.codex/config.toml enables the
// `remote_connections` feature, which lets the Codex app pick up SSH host
// aliases from ~/.ssh/config:
//
//	[features]
//	remote_connections = true
//
// Every other key in the file is preserved. It reports whether the file was
// changed, so callers stay quiet when the feature is already on, and only
// rewrites the file when the flag actually needs flipping (a rewrite drops TOML
// comments and reorders keys, so we avoid it otherwise). A missing file is
// created.
func EnableCodexRemoteConnections(paths basedir.Paths) (bool, error) {
	path, err := paths.CodexConfigFile()
	if err != nil {
		return false, err
	}
	raw, err := readFileOrEmpty(path)
	if err != nil {
		return false, fmt.Errorf("read %s: %w", path, err)
	}

	doc := map[string]any{}
	if len(bytes.TrimSpace(raw)) > 0 {
		if err := toml.Unmarshal(raw, &doc); err != nil {
			return false, fmt.Errorf("parse %s (is it valid TOML?): %w", path, err)
		}
	}

	features, _ := doc["features"].(map[string]any)
	if features == nil {
		features = map[string]any{}
	}
	if enabled, ok := features["remote_connections"].(bool); ok && enabled {
		return false, nil
	}
	features["remote_connections"] = true
	doc["features"] = features

	var buf bytes.Buffer
	if err := toml.NewEncoder(&buf).Encode(doc); err != nil {
		return false, fmt.Errorf("encode %s: %w", path, err)
	}
	if err := writeFileAtomic(path, buf.Bytes()); err != nil {
		return false, err
	}
	return true, nil
}

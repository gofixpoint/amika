// Package appcfg writes local configuration for third-party coding apps
// (Claude Desktop, Codex) so they can open Amika sandboxes over SSH.
//
// The SSH connection itself is defined once in the Amika-managed SSH config
// (see internal/ssh): a stable `amika-<id>` Host alias in ~/.ssh/amika.conf,
// pulled into ~/.ssh/config via an Include. Both Claude Desktop and Codex read
// ~/.ssh/config, so all this package does is make each app aware of that alias:
//
//   - Claude Desktop keeps SSH environments in ~/.claude/settings.json under
//     `sshConfigs`; we upsert an entry whose `sshHost` is the alias.
//   - Codex reads host aliases straight from ~/.ssh/config once the
//     `remote_connections` feature is enabled in ~/.codex/config.toml.
package appcfg

import (
	"fmt"
	"os"
	"path/filepath"
)

// writeFileAtomic writes data to path via a temp file + rename so a concurrent
// reader never observes a partially written file. The parent directory is
// created 0700 and the file is written 0600, matching how the SSH config and
// other Amika-managed dotfiles are persisted.
func writeFileAtomic(path string, data []byte) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return fmt.Errorf("create %s: %w", dir, err)
	}
	tmp, err := os.CreateTemp(dir, ".amika-*.tmp")
	if err != nil {
		return fmt.Errorf("create temp file in %s: %w", dir, err)
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName)

	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return fmt.Errorf("write temp file: %w", err)
	}
	if err := tmp.Chmod(0o600); err != nil {
		tmp.Close()
		return fmt.Errorf("chmod temp file: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("close temp file: %w", err)
	}
	if err := os.Rename(tmpName, path); err != nil {
		return fmt.Errorf("rename temp file to %s: %w", path, err)
	}
	return nil
}

// readFileOrEmpty returns the file contents, or nil if the file does not exist.
func readFileOrEmpty(path string) ([]byte, error) {
	data, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return data, nil
}

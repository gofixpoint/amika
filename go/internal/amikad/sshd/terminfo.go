package sshd

import (
	_ "embed"
	"os"
	"path/filepath"
)

// xtermGhostty is the compiled terminfo entry for Ghostty, which sets
// TERM=xterm-ghostty. The system terminfo database often lacks it. Without
// it, zsh and other line editors fall back to a dumb terminal: no prompt
// colors, and backspace and cursor movement break.
//
// terminfo/compile.sh builds it from terminfo/xterm-ghostty.src, and the
// terminfo CI workflow checks that the two match.
//
//go:embed terminfo/xterm-ghostty
var xtermGhostty []byte

// terminfoPaths are where installTerminfo writes the entry: under each name
// it answers to, in the hex directory layout (macOS) and the first-letter
// layout (Linux).
var terminfoPaths = []string{
	"78/xterm-ghostty",
	"x/xterm-ghostty",
	"67/ghostty",
	"g/ghostty",
}

// installTerminfo writes the bundled entry under directory, replacing any
// earlier copy.
func installTerminfo(files AtomicFiles, directory string) error {
	for _, path := range terminfoPaths {
		target := filepath.Join(directory, path)
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			return err
		}
		if err := files.WriteFileAtomic(target, xtermGhostty, 0o644); err != nil {
			return err
		}
	}
	return nil
}

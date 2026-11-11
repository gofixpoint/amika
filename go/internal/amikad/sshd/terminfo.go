package sshd

import (
	"embed"
	"io/fs"
	"os"
	"path/filepath"
)

// bundledTerminfo holds compiled entries for terminals whose TERM the system
// terminfo database often lacks, such as xterm-ghostty. Without an entry,
// zsh and other line editors fall back to a dumb terminal: no prompt colors,
// and backspace and cursor movement break.
//
// Each entry is stored twice: under a hex directory (78/, the macOS layout)
// and a first-letter directory (x/, the Linux layout). Regenerate an entry
// from its .src file with the legacy-format tic that macOS ships, which every
// ncurses reads:
//
//	TERMINFO=out /usr/bin/tic -x terminfo/xterm-ghostty.src
//
//go:embed terminfo/*/*
var bundledTerminfo embed.FS

// installTerminfo writes every bundled entry under directory, replacing any
// earlier copy.
func installTerminfo(files AtomicFiles, directory string) error {
	return fs.WalkDir(bundledTerminfo, "terminfo", func(path string, entry fs.DirEntry, err error) error {
		if err != nil || entry.IsDir() {
			return err
		}
		contents, err := bundledTerminfo.ReadFile(path)
		if err != nil {
			return err
		}
		relative, err := filepath.Rel("terminfo", path)
		if err != nil {
			return err
		}
		target := filepath.Join(directory, relative)
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			return err
		}
		return files.WriteFileAtomic(target, contents, 0o644)
	})
}

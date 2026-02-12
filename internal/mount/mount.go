package mount

import (
	"fmt"
	"os"
	"os/exec"

	"github.com/gofixpoint/clawbox/internal/deps"
	"github.com/gofixpoint/clawbox/internal/state"
)

// Mode represents the mount access mode.
type Mode string

const (
	ModeReadOnly Mode = "ro"
	ModeReadWrite Mode = "rw"
	ModeOverlay  Mode = "overlay"
)

// ValidateMode checks if a mode string is valid.
func ValidateMode(mode string) error {
	switch Mode(mode) {
	case ModeReadOnly, ModeReadWrite, ModeOverlay:
		return nil
	default:
		return fmt.Errorf("invalid mode %q: must be ro, rw, or overlay", mode)
	}
}

// Mount mounts a source directory to a target path with the specified mode.
func Mount(src, target, mode string, st state.State) error {
	// Check dependencies
	if err := deps.CheckAll(); err != nil {
		return err
	}

	// Validate mode
	if err := ValidateMode(mode); err != nil {
		return err
	}

	// Validate source exists and is a directory
	srcInfo, err := os.Stat(src)
	if err != nil {
		if os.IsNotExist(err) {
			return fmt.Errorf("source directory does not exist: %s", src)
		}
		return fmt.Errorf("failed to stat source: %w", err)
	}
	if !srcInfo.IsDir() {
		return fmt.Errorf("source is not a directory: %s", src)
	}

	// Check if target is already mounted
	if st.MountExists(target) {
		return fmt.Errorf("target is already mounted: %s", target)
	}

	// Create target directory if it doesn't exist
	if err := os.MkdirAll(target, 0755); err != nil {
		return fmt.Errorf("failed to create target directory: %w", err)
	}

	var mountInfo state.MountInfo
	mountInfo.Source = src
	mountInfo.Target = target
	mountInfo.Mode = mode

	switch Mode(mode) {
	case ModeReadOnly:
		if err := mountReadOnly(src, target); err != nil {
			return err
		}
	case ModeReadWrite:
		if err := mountReadWrite(src, target); err != nil {
			return err
		}
	case ModeOverlay:
		tempDir, err := mountOverlay(src, target)
		if err != nil {
			return err
		}
		mountInfo.TempDir = tempDir
	}

	// Save mount info to state
	if err := st.SaveMount(mountInfo); err != nil {
		// Try to unmount and clean up if we fail to save state
		unmountBindfs(target)
		if mountInfo.TempDir != "" {
			os.RemoveAll(mountInfo.TempDir)
		}
		return fmt.Errorf("failed to save mount state: %w", err)
	}

	return nil
}

// mountReadOnly mounts source to target in read-only mode.
func mountReadOnly(src, target string) error {
	cmd := exec.Command("bindfs", "-o", "ro", src, target)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("bindfs read-only mount failed: %w", err)
	}
	return nil
}

// mountReadWrite mounts source to target in read-write mode.
func mountReadWrite(src, target string) error {
	cmd := exec.Command("bindfs", src, target)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("bindfs read-write mount failed: %w", err)
	}
	return nil
}

// mountOverlay creates a copy of source in a temp directory and mounts it.
func mountOverlay(src, target string) (string, error) {
	// Create temp directory
	tempDir, err := os.MkdirTemp("", "clawbox-overlay-*")
	if err != nil {
		return "", fmt.Errorf("failed to create temp directory: %w", err)
	}

	// Copy source to temp using rsync
	// The trailing slash on src ensures we copy contents, not the directory itself
	rsyncCmd := exec.Command("rsync", "-a", src+"/", tempDir+"/")
	rsyncCmd.Stdout = os.Stdout
	rsyncCmd.Stderr = os.Stderr
	if err := rsyncCmd.Run(); err != nil {
		os.RemoveAll(tempDir)
		return "", fmt.Errorf("rsync copy failed: %w", err)
	}

	// Mount temp directory to target
	bindfsCmd := exec.Command("bindfs", tempDir, target)
	bindfsCmd.Stdout = os.Stdout
	bindfsCmd.Stderr = os.Stderr
	if err := bindfsCmd.Run(); err != nil {
		os.RemoveAll(tempDir)
		return "", fmt.Errorf("bindfs overlay mount failed: %w", err)
	}

	return tempDir, nil
}

// unmountBindfs unmounts a bindfs mount (helper for cleanup).
func unmountBindfs(target string) error {
	cmd := exec.Command("umount", target)
	return cmd.Run()
}

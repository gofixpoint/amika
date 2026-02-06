package mount

import (
	"fmt"
	"os"
	"os/exec"
	"runtime"

	"github.com/gofixpoint/wisp/internal/state"
)

// Unmount unmounts a target and cleans up any associated resources.
func Unmount(target string, st state.State) error {
	// Get mount info from state
	info, err := st.GetMount(target)
	if err != nil {
		return fmt.Errorf("target is not mounted: %s", target)
	}

	// Unmount the bindfs mount
	if err := doUnmount(target); err != nil {
		return fmt.Errorf("failed to unmount %s: %w", target, err)
	}

	// If overlay mode, clean up temp directory
	if info.Mode == string(ModeOverlay) && info.TempDir != "" {
		if err := os.RemoveAll(info.TempDir); err != nil {
			// Log warning but don't fail
			fmt.Fprintf(os.Stderr, "Warning: failed to remove temp directory %s: %v\n", info.TempDir, err)
		}
	}

	// Remove mount from state
	if err := st.RemoveMount(target); err != nil {
		return fmt.Errorf("failed to remove mount from state: %w", err)
	}

	return nil
}

// doUnmount performs the actual unmount operation.
func doUnmount(target string) error {
	var cmd *exec.Cmd

	if runtime.GOOS == "darwin" {
		// On macOS, use diskutil unmount for better compatibility
		cmd = exec.Command("diskutil", "unmount", target)
	} else {
		// On Linux and others, use umount
		cmd = exec.Command("umount", target)
	}

	output, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("%s: %s", err, string(output))
	}

	return nil
}

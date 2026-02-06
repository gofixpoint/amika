package deps

import (
	"strings"
	"testing"
)

func TestDependencyError(t *testing.T) {
	err := &DependencyError{
		Name:         "test-dep",
		Instructions: "Install with: test install",
	}

	msg := err.Error()
	if !strings.Contains(msg, "test-dep") {
		t.Errorf("error message should contain dependency name, got: %s", msg)
	}
	if !strings.Contains(msg, "Install with: test install") {
		t.Errorf("error message should contain instructions, got: %s", msg)
	}
}

func TestCheckBindfs(t *testing.T) {
	// This test checks the actual system state.
	// If bindfs is installed, it should pass; if not, it should return an error.
	err := CheckBindfs()
	if err != nil {
		depErr, ok := err.(*DependencyError)
		if !ok {
			t.Errorf("expected DependencyError, got: %T", err)
		}
		if depErr.Name != "bindfs" {
			t.Errorf("expected name 'bindfs', got: %s", depErr.Name)
		}
		if !strings.Contains(depErr.Instructions, "brew install bindfs") {
			t.Errorf("instructions should mention brew install, got: %s", depErr.Instructions)
		}
	}
}

func TestCheckMacFUSE(t *testing.T) {
	// This test checks the actual system state.
	err := CheckMacFUSE()
	if err != nil {
		depErr, ok := err.(*DependencyError)
		if !ok {
			t.Errorf("expected DependencyError, got: %T", err)
		}
		if depErr.Name != "macFUSE" {
			t.Errorf("expected name 'macFUSE', got: %s", depErr.Name)
		}
		if !strings.Contains(depErr.Instructions, "osxfuse.github.io") {
			t.Errorf("instructions should mention osxfuse.github.io, got: %s", depErr.Instructions)
		}
	}
}

func TestCheckAll(t *testing.T) {
	// CheckAll should return nil only if both dependencies are installed
	err := CheckAll()
	if err != nil {
		// Verify it's a DependencyError
		_, ok := err.(*DependencyError)
		if !ok {
			t.Errorf("expected DependencyError, got: %T", err)
		}
	}
}

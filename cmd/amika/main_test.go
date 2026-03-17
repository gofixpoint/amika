package main

import (
	"strings"
	"testing"

	"github.com/gofixpoint/amika/internal/buildmeta"
)

func TestRootVersionFlag(t *testing.T) {
	originalVersion := buildmeta.AmikaVersion
	t.Cleanup(func() {
		buildmeta.AmikaVersion = originalVersion
		rootCmd.Version = versionString()
	})

	buildmeta.AmikaVersion = "v2.0.0-beta.1"
	rootCmd.Version = versionString()

	output, err := runRootCommand("--version")
	if err != nil {
		t.Fatalf("runRootCommand() error = %v", err)
	}
	if !strings.Contains(output, "amika version v2.0.0-beta.1") {
		t.Fatalf("runRootCommand() output = %q, want version line", output)
	}
	if !strings.Contains(output, "commit: ") {
		t.Fatalf("runRootCommand() output = %q, want commit line", output)
	}
}

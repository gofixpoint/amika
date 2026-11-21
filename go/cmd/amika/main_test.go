package main

import (
	"fmt"
	"strings"
	"testing"

	"github.com/gofixpoint/amika/go/internal/buildmeta"
	"github.com/gofixpoint/amika/go/internal/ssh"
)

func TestRootVersionFlag(t *testing.T) {
	originalVersion := buildmeta.AmikaVersion
	t.Cleanup(func() {
		buildmeta.AmikaVersion = originalVersion
		rootCmd.Version = versionString()
	})

	buildmeta.AmikaVersion = buildmeta.MustParseSemVer("v2.0.0-beta.1")
	rootCmd.Version = versionString()

	output, err := runRootCommand("--version")
	if err != nil {
		t.Fatalf("runRootCommand() error = %v", err)
	}
	if !strings.Contains(output, "version: v2.0.0-beta.1") {
		t.Fatalf("runRootCommand() output = %q, want version line", output)
	}
	if !strings.Contains(output, "commit: ") {
		t.Fatalf("runRootCommand() output = %q, want commit line", output)
	}
}

func TestVersionSubcommand(t *testing.T) {
	originalVersion := buildmeta.AmikaVersion
	t.Cleanup(func() {
		buildmeta.AmikaVersion = originalVersion
		rootCmd.Version = versionString()
	})

	buildmeta.AmikaVersion = buildmeta.MustParseSemVer("v2.0.0-beta.1")
	rootCmd.Version = versionString()

	output, err := runRootCommand("version")
	if err != nil {
		t.Fatalf("runRootCommand() error = %v", err)
	}
	if !strings.Contains(output, "version: v2.0.0-beta.1") {
		t.Fatalf("runRootCommand() output = %q, want version line", output)
	}
	if !strings.Contains(output, "commit: ") {
		t.Fatalf("runRootCommand() output = %q, want commit line", output)
	}
	if !strings.Contains(output, "date: ") {
		t.Fatalf("runRootCommand() output = %q, want date line", output)
	}
}

// childExit has an ExitCode method, as a subprocess's *exec.ExitError does.
type childExit struct{}

func (childExit) Error() string { return "child exited" }
func (childExit) ExitCode() int { return 3 }

func TestExitCodeCarriesOnlyTheSSHProxyStatus(t *testing.T) {
	proxy := fmt.Errorf("proxy: %w", &ssh.ProxyExitError{Code: 255, Message: "gone"})
	if got := exitCode(proxy); got != 255 {
		t.Errorf("proxy exit = %d, want 255", got)
	}
	if got := exitCode(fmt.Errorf("editor failed: %w", childExit{})); got != 1 {
		t.Errorf("subprocess exit = %d, want 1", got)
	}
}

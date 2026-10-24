//go:build linux

package oomscore

import (
	"bytes"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

func TestProtectWritesDaemonScoreAdj(t *testing.T) {
	path := filepath.Join(t.TempDir(), "oom_score_adj")
	if err := os.WriteFile(path, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	var logs bytes.Buffer
	protect(path, slog.New(slog.NewTextHandler(&logs, nil)))

	contents, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(contents) != "-999" {
		t.Fatalf("oom_score_adj = %q, want -999", contents)
	}
	if logs.Len() != 0 {
		t.Fatalf("unexpected log output %q", logs.String())
	}
}

func TestProtectFailureIsOnlyAWarning(t *testing.T) {
	// A missing file stands in for an unwritable one: neither may be created
	// or abort the caller, only reported.
	path := filepath.Join(t.TempDir(), "missing", "oom_score_adj")
	var logs bytes.Buffer
	protect(path, slog.New(slog.NewTextHandler(&logs, nil)))

	if !strings.Contains(logs.String(), "level=WARN") || !strings.Contains(logs.String(), path) {
		t.Fatalf("log = %q, want a warning naming %s", logs.String(), path)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("protect created %s: %v", path, err)
	}
}

func TestCommandResetsScoreBeforeExecingChild(t *testing.T) {
	name, args := Command("/usr/sbin/sshd", "-D", "-e", "-f", "/var/lib/amikad/sshd_config")

	want := []string{
		"-c", `echo 0 > /proc/self/oom_score_adj; exec "$@"`, "amikad-oom-reset",
		"/usr/sbin/sshd", "-D", "-e", "-f", "/var/lib/amikad/sshd_config",
	}
	if name != "/bin/sh" || !slices.Equal(args, want) {
		t.Fatalf("command = %q %q, want /bin/sh %q", name, args, want)
	}
}

func TestCommandPassesArgumentsThroughVerbatim(t *testing.T) {
	printf, err := exec.LookPath("printf")
	if err != nil {
		t.Skip("printf not available")
	}
	childArgs := []string{"a b", "$HOME", "*", "; echo injected", ""}
	name, args := Command(printf, append([]string{`%s\n`}, childArgs...)...)

	output, err := exec.Command(name, args...).Output()
	if err != nil {
		t.Fatalf("run wrapped printf: %v", err)
	}
	if got := strings.Split(strings.TrimSuffix(string(output), "\n"), "\n"); !slices.Equal(got, childArgs) {
		t.Fatalf("child saw %q, want %q", got, childArgs)
	}
}

package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func runRootCommand(args ...string) (string, error) {
	buf := &strings.Builder{}
	rootCmd.SetOut(buf)
	rootCmd.SetErr(buf)
	rootCmd.SetArgs(args)
	err := rootCmd.Execute()
	rootCmd.SetArgs(nil)
	return buf.String(), err
}

// buildAmika builds the amika binary for integration tests and returns its path.
func buildAmika(t *testing.T) string {
	t.Helper()
	binPath := filepath.Join(t.TempDir(), "amika")
	cmd := exec.Command("go", "build", "-o", binPath, "./")
	cmd.Dir = filepath.Join(findModuleRoot(t), "cmd", "amika")
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("failed to build amika: %v\n%s", err, out)
	}
	return binPath
}

// findModuleRoot walks up from the test file's directory to find go.mod.
func findModuleRoot(t *testing.T) string {
	t.Helper()
	dir, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	for {
		if _, err := os.Stat(filepath.Join(dir, "go.mod")); err == nil {
			return dir
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			t.Fatal("could not find module root (go.mod)")
		}
		dir = parent
	}
}

// withEnv returns base with each KEY=VALUE in kvs appended, replacing any
// existing entry for the same key.
func withEnv(base []string, kvs ...string) []string {
	env := append([]string(nil), base...)
	for _, kv := range kvs {
		key, _, ok := strings.Cut(kv, "=")
		if !ok {
			env = append(env, kv)
			continue
		}

		prefix := key + "="
		filtered := env[:0]
		for _, existing := range env {
			if !strings.HasPrefix(existing, prefix) {
				filtered = append(filtered, existing)
			}
		}
		env = append(filtered, kv)
	}
	return env
}

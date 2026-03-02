// Package testutil provides shared helpers for integration and contract tests.
package testutil

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

const (
	// RunDockerIntegrationTestsEnv gates Docker-backed integration tests.
	RunDockerIntegrationTestsEnv = "AMIKA_RUN_DOCKER_INTEGRATION"
)

// BuildAmikaBinary builds amika and returns the path to the binary.
func BuildAmikaBinary(t *testing.T) string {
	t.Helper()

	moduleRoot := FindModuleRoot(t)
	binPath := filepath.Join(t.TempDir(), "amika")
	cmd := exec.Command("go", "build", "-o", binPath, "./cmd/amika")
	cmd.Dir = moduleRoot
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("failed to build amika: %v\n%s", err, string(out))
	}
	return binPath
}

// FindModuleRoot returns the repository root that contains go.mod.
func FindModuleRoot(t *testing.T) string {
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

// RequireDockerIntegration skips unless docker integration tests are enabled and docker is available.
func RequireDockerIntegration(t *testing.T) {
	t.Helper()

	if os.Getenv(RunDockerIntegrationTestsEnv) != "1" {
		t.Skipf("set %s=1 to run Docker integration tests", RunDockerIntegrationTestsEnv)
	}

	cmd := exec.Command("docker", "info")
	if err := cmd.Run(); err != nil {
		t.Skipf("docker unavailable: %v", err)
	}
}

// NewSandboxName returns a sandbox name suitable for tests.
func NewSandboxName(prefix string) string {
	return fmt.Sprintf("%s-%d-%d", prefix, os.Getpid(), time.Now().UnixNano())
}

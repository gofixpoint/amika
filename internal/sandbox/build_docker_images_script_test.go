package sandbox

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestBuildDockerImagesScript_AllBuildsFullGraphAndPushesOnlyDaytona(t *testing.T) {
	repoRoot := repoRootForScriptTest(t)
	logDir := t.TempDir()
	binDir := writeFakeCLIs(t, logDir)

	cmd := exec.Command(filepath.Join(repoRoot, "bin", "build-docker-images"), "all", "--ignore-unstaged", "--push-daytona")
	cmd.Dir = repoRoot
	cmd.Env = append(os.Environ(),
		"PATH="+binDir+string(os.PathListSeparator)+os.Getenv("PATH"),
		"FAKE_LOG_DIR="+logDir,
	)

	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("script failed: %v\n%s", err, out)
	}

	dockerLines := readLogLines(t, filepath.Join(logDir, "docker.log"))
	if len(dockerLines) != 5 {
		t.Fatalf("docker build count = %d, want 5\nlines=%q", len(dockerLines), dockerLines)
	}

	wantOrder := []string{
		"amika/base",
		"amika/coder",
		"amika/claude",
		"amika/daytona-coder",
		"amika/daytona-claude",
	}
	for i, want := range wantOrder {
		if !strings.Contains(dockerLines[i], "-t "+want+":abc123") {
			t.Fatalf("docker line %d = %q, want hash tag for %q", i, dockerLines[i], want)
		}
		if !strings.Contains(dockerLines[i], "-t "+want+":latest") {
			t.Fatalf("docker line %d = %q, want latest tag for %q", i, dockerLines[i], want)
		}
	}
	if !strings.Contains(dockerLines[1], "--build-arg BASE_IMAGE=amika/base:abc123") {
		t.Fatalf("coder build args missing base image: %q", dockerLines[1])
	}
	if !strings.Contains(dockerLines[2], "--build-arg BASE_IMAGE=amika/base:abc123") {
		t.Fatalf("claude build args missing base image: %q", dockerLines[2])
	}
	if !strings.Contains(dockerLines[3], "--build-arg CODER_IMAGE=amika/coder:abc123") {
		t.Fatalf("daytona-coder build args missing coder image: %q", dockerLines[3])
	}
	if !strings.Contains(dockerLines[4], "--build-arg CLAUDE_IMAGE=amika/claude:abc123") {
		t.Fatalf("daytona-claude build args missing claude image: %q", dockerLines[4])
	}
	for _, line := range dockerLines {
		if !strings.Contains(line, "--platform linux/amd64") {
			t.Fatalf("docker line missing linux/amd64 platform: %q", line)
		}
	}

	daytonaLines := readLogLines(t, filepath.Join(logDir, "daytona.log"))
	wantPushes := []string{
		"snapshot push amika/daytona-coder:abc123 --name amika/daytona-coder:abc123",
		"snapshot push amika/daytona-claude:abc123 --name amika/daytona-claude:abc123",
	}
	if len(daytonaLines) != len(wantPushes) {
		t.Fatalf("daytona push count = %d, want %d\nlines=%q", len(daytonaLines), len(wantPushes), daytonaLines)
	}
	for i, want := range wantPushes {
		if daytonaLines[i] != want {
			t.Fatalf("daytona line %d = %q, want %q", i, daytonaLines[i], want)
		}
	}
}

func TestBuildDockerImagesScript_DaytonaTargetBuildsPrereqs(t *testing.T) {
	repoRoot := repoRootForScriptTest(t)
	logDir := t.TempDir()
	binDir := writeFakeCLIs(t, logDir)

	cmd := exec.Command(filepath.Join(repoRoot, "bin", "build-docker-images"), "amika/daytona-coder", "--ignore-unstaged")
	cmd.Dir = repoRoot
	cmd.Env = append(os.Environ(),
		"PATH="+binDir+string(os.PathListSeparator)+os.Getenv("PATH"),
		"FAKE_LOG_DIR="+logDir,
	)

	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("script failed: %v\n%s", err, out)
	}

	dockerLines := readLogLines(t, filepath.Join(logDir, "docker.log"))
	if len(dockerLines) != 3 {
		t.Fatalf("docker build count = %d, want 3\nlines=%q", len(dockerLines), dockerLines)
	}
	if !strings.Contains(dockerLines[0], "-t amika/base:abc123") || !strings.Contains(dockerLines[0], "-t amika/base:latest") {
		t.Fatalf("first build should be base, got %q", dockerLines[0])
	}
	if !strings.Contains(dockerLines[1], "-t amika/coder:abc123") || !strings.Contains(dockerLines[1], "-t amika/coder:latest") {
		t.Fatalf("second build should be coder, got %q", dockerLines[1])
	}
	if !strings.Contains(dockerLines[2], "-t amika/daytona-coder:abc123") || !strings.Contains(dockerLines[2], "-t amika/daytona-coder:latest") {
		t.Fatalf("third build should be daytona-coder, got %q", dockerLines[2])
	}
}

func TestBuildDockerImagesScript_RejectsArm64PushDaytona(t *testing.T) {
	repoRoot := repoRootForScriptTest(t)
	logDir := t.TempDir()
	binDir := writeFakeCLIs(t, logDir)

	cmd := exec.Command(filepath.Join(repoRoot, "bin", "build-docker-images"), "all", "--platform", "linux/arm64", "--push-daytona")
	cmd.Dir = repoRoot
	cmd.Env = append(os.Environ(),
		"PATH="+binDir+string(os.PathListSeparator)+os.Getenv("PATH"),
		"FAKE_LOG_DIR="+logDir,
	)

	out, err := cmd.CombinedOutput()
	if err == nil {
		t.Fatal("expected script to fail")
	}
	if !strings.Contains(string(out), "--push-daytona requires linux/amd64") {
		t.Fatalf("unexpected output: %s", out)
	}
}

func repoRootForScriptTest(t *testing.T) string {
	t.Helper()

	cwd, err := os.Getwd()
	if err != nil {
		t.Fatalf("getwd: %v", err)
	}
	return filepath.Clean(filepath.Join(cwd, "..", ".."))
}

func writeFakeCLIs(t *testing.T, _ string) string {
	t.Helper()

	binDir := t.TempDir()
	for name, body := range map[string]string{
		"git": `#!/bin/sh
for arg in "$@"; do
  if [ "$arg" = "status" ]; then
    printf '%s' "${FAKE_GIT_STATUS:-}"
    exit 0
  fi
  if [ "$arg" = "rev-parse" ]; then
    echo "abc123"
    exit 0
  fi
done
exit 0
`,
		"docker": `#!/bin/sh
echo "$*" >> "$FAKE_LOG_DIR/docker.log"
exit 0
`,
		"daytona": `#!/bin/sh
echo "$*" >> "$FAKE_LOG_DIR/daytona.log"
exit 0
`,
	} {
		path := filepath.Join(binDir, name)
		if err := os.WriteFile(path, []byte(body), 0755); err != nil {
			t.Fatalf("write %s: %v", name, err)
		}
	}

	return binDir
}

func readLogLines(t *testing.T, path string) []string {
	t.Helper()

	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		t.Fatalf("read %s: %v", path, err)
	}

	text := strings.TrimSpace(string(data))
	if text == "" {
		return nil
	}
	return strings.Split(text, "\n")
}

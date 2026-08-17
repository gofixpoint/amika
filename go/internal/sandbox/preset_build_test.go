package sandbox

import (
	"fmt"
	"io"
	"testing"
)

func TestBuildPresetImage_BuildsGeneratedDockerfile(t *testing.T) {
	resetPresetBuildStubs(t)

	var built string
	buildDockerImageWithArgsFn = func(name string, contextDir string, dockerfileRelPath string, buildArgs map[string]string, _ io.Writer) error {
		built = fmt.Sprintf("%s|%s|%s|%v", name, contextDir, dockerfileRelPath, buildArgs)
		return nil
	}

	if err := BuildPresetImage("coder-dind", "/tmp/context", io.Discard); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	want := "amika/coder-dind:latest|/tmp/context|sandbox-image/generated/coder-dind.Dockerfile|map[]"
	if built != want {
		t.Fatalf("built = %q, want %q", built, want)
	}
}

func TestBuildPresetImage_UsesPresetImagePrefix(t *testing.T) {
	resetPresetBuildStubs(t)
	t.Setenv(presetImagePrefixEnv, "amika-test-789")

	var imageName string
	buildDockerImageWithArgsFn = func(name string, _ string, _ string, _ map[string]string, _ io.Writer) error {
		imageName = name
		return nil
	}

	if err := BuildPresetImage("coder", "/tmp/context", io.Discard); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if imageName != "amika-test-789-coder:latest" {
		t.Fatalf("image name = %q", imageName)
	}
}

func TestBuildPresetImage_UnknownPreset(t *testing.T) {
	resetPresetBuildStubs(t)

	if err := BuildPresetImage("missing", "/tmp/context", io.Discard); err == nil {
		t.Fatal("expected error for unknown preset")
	}
}

func resetPresetBuildStubs(t *testing.T) {
	t.Helper()

	oldBuild := buildDockerImageWithArgsFn
	t.Cleanup(func() {
		buildDockerImageWithArgsFn = oldBuild
	})
}

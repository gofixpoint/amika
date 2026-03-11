package sandbox

import (
	"fmt"
	"reflect"
	"testing"
)

func TestBuildPresetImage_BuildsDependenciesInOrder(t *testing.T) {
	resetPresetBuildStubs(t)

	var built []string
	dockerImageExistsFn = func(_ string) bool { return false }
	buildDockerImageWithArgsFn = func(name string, contextDir string, dockerfileRelPath string, buildArgs map[string]string) error {
		built = append(built, fmt.Sprintf("%s|%s|%s|%v", name, contextDir, dockerfileRelPath, buildArgs))
		return nil
	}

	if err := BuildPresetImage("daytona-coder", "/tmp/context"); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	want := []string{
		"amika/base:latest|/tmp/context|base/Dockerfile|map[]",
		"amika/coder:latest|/tmp/context|coder/Dockerfile|map[BASE_IMAGE:amika/base:latest]",
		"amika/daytona-coder:latest|/tmp/context|daytona-coder/Dockerfile|map[CODER_IMAGE:amika/coder:latest]",
	}
	if !reflect.DeepEqual(built, want) {
		t.Fatalf("built sequence = %#v, want %#v", built, want)
	}
}

func TestBuildPresetImage_SkipsExistingDependencies(t *testing.T) {
	resetPresetBuildStubs(t)

	var built []string
	dockerImageExistsFn = func(name string) bool { return name == "amika/base:latest" }
	buildDockerImageWithArgsFn = func(name string, _ string, _ string, _ map[string]string) error {
		built = append(built, name)
		return nil
	}

	if err := BuildPresetImage("claude", "/tmp/context"); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	want := []string{"amika/claude:latest"}
	if !reflect.DeepEqual(built, want) {
		t.Fatalf("built sequence = %#v, want %#v", built, want)
	}
}

func TestBuildPresetImage_UsesPresetImagePrefixForDependencies(t *testing.T) {
	resetPresetBuildStubs(t)
	t.Setenv(presetImagePrefixEnv, "amika-test-789")

	var built []string
	dockerImageExistsFn = func(_ string) bool { return false }
	buildDockerImageWithArgsFn = func(name string, _ string, _ string, buildArgs map[string]string) error {
		built = append(built, fmt.Sprintf("%s|%v", name, buildArgs))
		return nil
	}

	if err := BuildPresetImage("daytona-claude", "/tmp/context"); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	want := []string{
		"amika-test-789-base:latest|map[]",
		"amika-test-789-claude:latest|map[BASE_IMAGE:amika-test-789-base:latest]",
		"amika-test-789-daytona-claude:latest|map[CLAUDE_IMAGE:amika-test-789-claude:latest]",
	}
	if !reflect.DeepEqual(built, want) {
		t.Fatalf("built sequence = %#v, want %#v", built, want)
	}
}

func TestBuildPresetImage_UnknownPreset(t *testing.T) {
	resetPresetBuildStubs(t)

	if err := BuildPresetImage("missing", "/tmp/context"); err == nil {
		t.Fatal("expected error for unknown preset")
	}
}

func resetPresetBuildStubs(t *testing.T) {
	t.Helper()

	oldExists := dockerImageExistsFn
	oldBuild := buildDockerImageWithArgsFn

	t.Cleanup(func() {
		dockerImageExistsFn = oldExists
		buildDockerImageWithArgsFn = oldBuild
	})
}

func TestPresetBuildOrder(t *testing.T) {
	t.Run("known preset", func(t *testing.T) {
		order, err := presetBuildOrder("daytona-coder")
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		want := []string{"base", "coder", "daytona-coder"}
		if !reflect.DeepEqual(order, want) {
			t.Fatalf("order = %#v, want %#v", order, want)
		}
	})

	t.Run("unknown preset", func(t *testing.T) {
		if _, err := presetBuildOrder("missing"); err == nil {
			t.Fatal("expected error for unknown preset")
		}
	})
}

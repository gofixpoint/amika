package sandbox

import (
	"bytes"
	"errors"
	"testing"
)

func TestResolveAndEnsureImage_PresetAndImageMutuallyExclusive(t *testing.T) {
	_, err := ResolveAndEnsureImage(PresetImageOptions{
		Image:            "ubuntu:latest",
		Preset:           "claude",
		ImageFlagChanged: true,
	})
	if err == nil {
		t.Fatal("expected error, got nil")
	}
}

func TestResolveAndEnsureImage_ExplicitClaudePresetBuildsWhenMissing(t *testing.T) {
	resetImageResolutionStubs(t)

	var builtImage string
	var gotBuildPreset string
	dockerImageExistsFn = func(_ string) bool { return false }
	getPresetDockerfileFn = func(name string) ([]byte, error) {
		gotBuildPreset = name
		return []byte("FROM scratch"), nil
	}
	buildDockerImageFn = func(name string, _ []byte) error {
		builtImage = name
		return nil
	}

	res, err := ResolveAndEnsureImage(PresetImageOptions{
		Image:              "amika/claude:latest",
		Preset:             "claude",
		DefaultBuildPreset: "coder",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if res.Image != "amika/claude:latest" {
		t.Fatalf("image = %q, want %q", res.Image, "amika/claude:latest")
	}
	if res.EffectivePreset != "claude" {
		t.Fatalf("effective preset = %q, want %q", res.EffectivePreset, "claude")
	}
	if res.BuildPreset != "claude" {
		t.Fatalf("build preset = %q, want %q", res.BuildPreset, "claude")
	}
	if gotBuildPreset != "claude" {
		t.Fatalf("dockerfile preset = %q, want %q", gotBuildPreset, "claude")
	}
	if builtImage != "amika/claude:latest" {
		t.Fatalf("built image = %q, want %q", builtImage, "amika/claude:latest")
	}
}

func TestResolveAndEnsureImage_ExplicitCoderPresetBuildsWhenMissing(t *testing.T) {
	resetImageResolutionStubs(t)

	var builtImage string
	var gotBuildPreset string
	dockerImageExistsFn = func(_ string) bool { return false }
	getPresetDockerfileFn = func(name string) ([]byte, error) {
		gotBuildPreset = name
		return []byte("FROM scratch"), nil
	}
	buildDockerImageFn = func(name string, _ []byte) error {
		builtImage = name
		return nil
	}

	res, err := ResolveAndEnsureImage(PresetImageOptions{
		Image:              DefaultCoderImage,
		Preset:             "coder",
		DefaultBuildPreset: "coder",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if res.Image != DefaultCoderImage {
		t.Fatalf("image = %q, want %q", res.Image, DefaultCoderImage)
	}
	if res.EffectivePreset != "coder" {
		t.Fatalf("effective preset = %q, want %q", res.EffectivePreset, "coder")
	}
	if res.BuildPreset != "coder" {
		t.Fatalf("build preset = %q, want %q", res.BuildPreset, "coder")
	}
	if gotBuildPreset != "coder" {
		t.Fatalf("dockerfile preset = %q, want %q", gotBuildPreset, "coder")
	}
	if builtImage != DefaultCoderImage {
		t.Fatalf("built image = %q, want %q", builtImage, DefaultCoderImage)
	}
}

func TestResolveAndEnsureImage_DefaultBuildPresetWhenImageNotChanged(t *testing.T) {
	resetImageResolutionStubs(t)

	var built bool
	dockerImageExistsFn = func(_ string) bool { return false }
	getPresetDockerfileFn = func(_ string) ([]byte, error) {
		return []byte("FROM scratch"), nil
	}
	buildDockerImageFn = func(_ string, _ []byte) error {
		built = true
		return nil
	}

	res, err := ResolveAndEnsureImage(PresetImageOptions{
		Image:              DefaultCoderImage,
		ImageFlagChanged:   false,
		DefaultBuildPreset: "coder",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if res.Image != DefaultCoderImage {
		t.Fatalf("image = %q, want %q", res.Image, DefaultCoderImage)
	}
	if res.BuildPreset != "coder" {
		t.Fatalf("build preset = %q, want %q", res.BuildPreset, "coder")
	}
	if !built {
		t.Fatal("expected build to run")
	}
}

func TestResolveAndEnsureImage_NoDefaultBuildWhenImageChanged(t *testing.T) {
	resetImageResolutionStubs(t)

	buildCalled := false
	dockerImageExistsFn = func(_ string) bool { return false }
	getPresetDockerfileFn = func(_ string) ([]byte, error) {
		return []byte("FROM scratch"), nil
	}
	buildDockerImageFn = func(_ string, _ []byte) error {
		buildCalled = true
		return nil
	}

	res, err := ResolveAndEnsureImage(PresetImageOptions{
		Image:              "ubuntu:latest",
		ImageFlagChanged:   true,
		DefaultBuildPreset: "coder",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if res.BuildPreset != "" {
		t.Fatalf("build preset = %q, want empty", res.BuildPreset)
	}
	if buildCalled {
		t.Fatal("build should not have been called")
	}
}

func TestResolveAndEnsureImage_CustomImageNoPresetSkipsPresetBuildAndNormalization(t *testing.T) {
	resetImageResolutionStubs(t)

	dockerImageExistsFn = func(_ string) bool { return false }
	getPresetDockerfileFn = func(_ string) ([]byte, error) {
		t.Fatal("getPresetDockerfileFn should not be called")
		return nil, nil
	}
	buildDockerImageFn = func(_ string, _ []byte) error {
		t.Fatal("buildDockerImageFn should not be called")
		return nil
	}

	res, err := ResolveAndEnsureImage(PresetImageOptions{
		Image:              "ghcr.io/acme/custom:dev",
		ImageFlagChanged:   true,
		DefaultBuildPreset: "coder",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if res.Image != "ghcr.io/acme/custom:dev" {
		t.Fatalf("image = %q, want %q", res.Image, "ghcr.io/acme/custom:dev")
	}
	if res.EffectivePreset != "" {
		t.Fatalf("effective preset = %q, want empty", res.EffectivePreset)
	}
	if res.BuildPreset != "" {
		t.Fatalf("build preset = %q, want empty", res.BuildPreset)
	}
}

func TestResolveAndEnsureImage_UnknownPreset(t *testing.T) {
	resetImageResolutionStubs(t)

	dockerImageExistsFn = func(_ string) bool { return false }
	getPresetDockerfileFn = func(_ string) ([]byte, error) {
		return nil, errors.New("unknown preset")
	}

	_, err := ResolveAndEnsureImage(PresetImageOptions{
		Image:  DefaultCoderImage,
		Preset: "nope",
	})
	if err == nil {
		t.Fatal("expected error, got nil")
	}
}

func TestResolveAndEnsureImage_SkipsBuildWhenImageExists(t *testing.T) {
	resetImageResolutionStubs(t)

	buildCalled := false
	dockerImageExistsFn = func(_ string) bool { return true }
	buildDockerImageFn = func(_ string, _ []byte) error {
		buildCalled = true
		return nil
	}

	_, err := ResolveAndEnsureImage(PresetImageOptions{
		Image:              DefaultCoderImage,
		ImageFlagChanged:   false,
		DefaultBuildPreset: "coder",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if buildCalled {
		t.Fatal("build should not have been called")
	}
}

func TestResolveAndEnsureImage_UsesPresetImagePrefixOverride(t *testing.T) {
	resetImageResolutionStubs(t)
	t.Setenv(presetImagePrefixEnv, "amika-test-123")

	dockerImageExistsFn = func(_ string) bool { return true }

	res, err := ResolveAndEnsureImage(PresetImageOptions{
		Image:  DefaultCoderImage,
		Preset: "coder",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if res.Image != "amika-test-123-coder:latest" {
		t.Fatalf("image = %q, want %q", res.Image, "amika-test-123-coder:latest")
	}
}

func TestResolveAndEnsureImage_UsesPresetImagePrefixOverrideForDefaultBuildPreset(t *testing.T) {
	resetImageResolutionStubs(t)
	t.Setenv(presetImagePrefixEnv, "amika-test-456")

	dockerImageExistsFn = func(_ string) bool { return true }

	res, err := ResolveAndEnsureImage(PresetImageOptions{
		Image:              DefaultCoderImage,
		ImageFlagChanged:   false,
		DefaultBuildPreset: "coder",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if res.Image != "amika-test-456-coder:latest" {
		t.Fatalf("image = %q, want %q", res.Image, "amika-test-456-coder:latest")
	}
}

func resetImageResolutionStubs(t *testing.T) {
	t.Helper()

	oldExists := dockerImageExistsFn
	oldGetDockerfile := getPresetDockerfileFn
	oldBuild := buildDockerImageFn
	oldWriter := buildMessageWriter
	buildMessageWriter = &bytes.Buffer{}

	t.Cleanup(func() {
		dockerImageExistsFn = oldExists
		getPresetDockerfileFn = oldGetDockerfile
		buildDockerImageFn = oldBuild
		buildMessageWriter = oldWriter
	})
}

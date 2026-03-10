package sandbox

import (
	"bytes"
	"errors"
	"testing"
)

func TestResolveAndEnsureImage_PresetAndImageTogetherImageWins(t *testing.T) {
	resetImageResolutionStubs(t)

	buildCalled := false
	dockerImageExistsFn = func(_ string) bool { return true }
	buildDockerImageFn = func(_ string, _ string, _ string) error {
		buildCalled = true
		return nil
	}

	res, err := ResolveAndEnsureImage(PresetImageOptions{
		Image:            "ubuntu:latest",
		Preset:           "claude",
		ImageFlagChanged: true,
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if res.Image != "ubuntu:latest" {
		t.Fatalf("image = %q, want %q", res.Image, "ubuntu:latest")
	}
	if res.EffectivePreset != "claude" {
		t.Fatalf("effective preset = %q, want %q", res.EffectivePreset, "claude")
	}
	if res.BuildPreset != "" {
		t.Fatalf("build preset = %q, want empty", res.BuildPreset)
	}
	if buildCalled {
		t.Fatal("build should not have been called")
	}
}

func TestResolveAndEnsureImage_PresetAndImageTogetherNoAutoBuild(t *testing.T) {
	resetImageResolutionStubs(t)

	dockerImageExistsFn = func(_ string) bool { return false }
	writePresetBuildContextFn = func(_ string) (string, func(), error) {
		t.Fatal("writePresetBuildContextFn should not be called")
		return "", nil, nil
	}
	buildDockerImageFn = func(_ string, _ string, _ string) error {
		t.Fatal("buildDockerImageFn should not be called")
		return nil
	}

	res, err := ResolveAndEnsureImage(PresetImageOptions{
		Image:            "my-custom:dev",
		Preset:           "coder",
		ImageFlagChanged: true,
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if res.Image != "my-custom:dev" {
		t.Fatalf("image = %q, want %q", res.Image, "my-custom:dev")
	}
	if res.EffectivePreset != "coder" {
		t.Fatalf("effective preset = %q, want %q", res.EffectivePreset, "coder")
	}
	if res.BuildPreset != "" {
		t.Fatalf("build preset = %q, want empty", res.BuildPreset)
	}
}

func TestResolveAndEnsureImage_ExplicitClaudePresetBuildsWhenMissing(t *testing.T) {
	resetImageResolutionStubs(t)

	var builtImage string
	var builtContextDir string
	var builtDockerfileRelPath string
	dockerImageExistsFn = func(_ string) bool { return false }
	writePresetBuildContextFn = func(_ string) (string, func(), error) {
		return "/fake/context", func() {}, nil
	}
	buildDockerImageFn = func(name string, contextDir string, dockerfileRelPath string) error {
		builtImage = name
		builtContextDir = contextDir
		builtDockerfileRelPath = dockerfileRelPath
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
	if builtImage != "amika/claude:latest" {
		t.Fatalf("built image = %q, want %q", builtImage, "amika/claude:latest")
	}
	if builtContextDir != "/fake/context" {
		t.Fatalf("context dir = %q, want %q", builtContextDir, "/fake/context")
	}
	if builtDockerfileRelPath != "claude/Dockerfile" {
		t.Fatalf("dockerfile rel path = %q, want %q", builtDockerfileRelPath, "claude/Dockerfile")
	}
}

func TestResolveAndEnsureImage_ExplicitCoderPresetBuildsWhenMissing(t *testing.T) {
	resetImageResolutionStubs(t)

	var builtImage string
	dockerImageExistsFn = func(_ string) bool { return false }
	writePresetBuildContextFn = func(_ string) (string, func(), error) {
		return "/fake/context", func() {}, nil
	}
	buildDockerImageFn = func(name string, _ string, _ string) error {
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
	if builtImage != DefaultCoderImage {
		t.Fatalf("built image = %q, want %q", builtImage, DefaultCoderImage)
	}
}

func TestResolveAndEnsureImage_DefaultBuildPresetWhenImageNotChanged(t *testing.T) {
	resetImageResolutionStubs(t)

	var built bool
	dockerImageExistsFn = func(_ string) bool { return false }
	writePresetBuildContextFn = func(_ string) (string, func(), error) {
		return "/fake/context", func() {}, nil
	}
	buildDockerImageFn = func(_ string, _ string, _ string) error {
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
	writePresetBuildContextFn = func(_ string) (string, func(), error) {
		return "/fake/context", func() {}, nil
	}
	buildDockerImageFn = func(_ string, _ string, _ string) error {
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
	writePresetBuildContextFn = func(_ string) (string, func(), error) {
		t.Fatal("writePresetBuildContextFn should not be called")
		return "", nil, nil
	}
	buildDockerImageFn = func(_ string, _ string, _ string) error {
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
	writePresetBuildContextFn = func(_ string) (string, func(), error) {
		return "", nil, errors.New("unknown preset")
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
	buildDockerImageFn = func(_ string, _ string, _ string) error {
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
	oldBuild := buildDockerImageFn
	oldWriteContext := writePresetBuildContextFn
	oldWriter := buildMessageWriter
	buildMessageWriter = &bytes.Buffer{}

	t.Cleanup(func() {
		dockerImageExistsFn = oldExists
		buildDockerImageFn = oldBuild
		writePresetBuildContextFn = oldWriteContext
		buildMessageWriter = oldWriter
	})
}

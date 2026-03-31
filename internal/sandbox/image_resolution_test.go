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
	buildPresetImageFn = func(_ string, _ string) error {
		buildCalled = true
		return nil
	}

	res, err := ResolveAndEnsureImage(PresetImageOptions{
		Image:            "ubuntu:latest",
		Preset:           "coder-dind",
		ImageFlagChanged: true,
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if res.Image != "ubuntu:latest" {
		t.Fatalf("image = %q, want %q", res.Image, "ubuntu:latest")
	}
	if res.EffectivePreset != "coder-dind" {
		t.Fatalf("effective preset = %q, want %q", res.EffectivePreset, "coder-dind")
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
	buildPresetImageFn = func(_ string, _ string) error {
		t.Fatal("buildPresetImageFn should not be called")
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

func TestResolveAndEnsureImage_ExplicitCoderDindPresetBuildsWhenMissing(t *testing.T) {
	resetImageResolutionStubs(t)

	var builtPreset string
	var builtContextDir string
	dockerImageExistsFn = func(_ string) bool { return false }
	writePresetBuildContextFn = func(_ string) (string, func(), error) {
		return "/fake/context", func() {}, nil
	}
	buildPresetImageFn = func(preset string, contextDir string) error {
		builtPreset = preset
		builtContextDir = contextDir
		return nil
	}

	res, err := ResolveAndEnsureImage(PresetImageOptions{
		Image:              "amika/coder-dind:latest",
		Preset:             "coder-dind",
		DefaultBuildPreset: "coder",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if res.Image != "amika/coder-dind:latest" {
		t.Fatalf("image = %q, want %q", res.Image, "amika/coder-dind:latest")
	}
	if res.EffectivePreset != "coder-dind" {
		t.Fatalf("effective preset = %q, want %q", res.EffectivePreset, "coder-dind")
	}
	if res.BuildPreset != "coder-dind" {
		t.Fatalf("build preset = %q, want %q", res.BuildPreset, "coder-dind")
	}
	if builtPreset != "coder-dind" {
		t.Fatalf("built preset = %q, want %q", builtPreset, "coder-dind")
	}
	if builtContextDir != "/fake/context" {
		t.Fatalf("context dir = %q, want %q", builtContextDir, "/fake/context")
	}
}

func TestResolveAndEnsureImage_ExplicitCoderPresetBuildsWhenMissing(t *testing.T) {
	resetImageResolutionStubs(t)

	var builtPreset string
	dockerImageExistsFn = func(_ string) bool { return false }
	writePresetBuildContextFn = func(_ string) (string, func(), error) {
		return "/fake/context", func() {}, nil
	}
	buildPresetImageFn = func(preset string, _ string) error {
		builtPreset = preset
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
	if builtPreset != "coder" {
		t.Fatalf("built preset = %q, want %q", builtPreset, "coder")
	}
}

func TestResolveAndEnsureImage_DefaultBuildPresetWhenImageNotChanged(t *testing.T) {
	resetImageResolutionStubs(t)

	var built bool
	dockerImageExistsFn = func(_ string) bool { return false }
	writePresetBuildContextFn = func(_ string) (string, func(), error) {
		return "/fake/context", func() {}, nil
	}
	buildPresetImageFn = func(_ string, _ string) error {
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
	buildPresetImageFn = func(_ string, _ string) error {
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
	buildPresetImageFn = func(_ string, _ string) error {
		t.Fatal("buildPresetImageFn should not be called")
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
	buildPresetImageFn = func(_ string, _ string) error {
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
	oldBuildPreset := buildPresetImageFn
	oldWriteContext := writePresetBuildContextFn
	oldWriter := buildMessageWriter
	buildMessageWriter = &bytes.Buffer{}

	t.Cleanup(func() {
		dockerImageExistsFn = oldExists
		buildPresetImageFn = oldBuildPreset
		writePresetBuildContextFn = oldWriteContext
		buildMessageWriter = oldWriter
	})
}

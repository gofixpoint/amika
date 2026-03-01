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

func TestResolveAndEnsureImage_ExplicitPresetBuildsWhenMissing(t *testing.T) {
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
		Preset:             "claude",
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

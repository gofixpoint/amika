package sandbox

import (
	"fmt"
	"io"
	"os"
)

const presetImagePrefixEnv = "AMIKA_PRESET_IMAGE_PREFIX"

// DefaultCoderImage is the default Docker image used for the coder preset.
const DefaultCoderImage = "amika/coder:latest"

// PresetImageOptions controls how image/preset resolution and auto-build work.
type PresetImageOptions struct {
	Image              string
	Preset             string
	ImageFlagChanged   bool
	DefaultBuildPreset string
}

// PresetImageResult is the resolved image and preset/build metadata.
type PresetImageResult struct {
	Image           string
	EffectivePreset string
	BuildPreset     string
}

var (
	dockerImageExistsFn                 = DockerImageExists
	buildDockerImageFn                  = BuildDockerImage
	writePresetBuildContextFn           = WritePresetBuildContext
	buildMessageWriter        io.Writer = os.Stdout
)

// ResolveAndEnsureImage resolves image/preset behavior and auto-builds presets when needed.
func ResolveAndEnsureImage(opts PresetImageOptions) (PresetImageResult, error) {
	result := PresetImageResult{
		Image: opts.Image,
	}

	if opts.Preset != "" {
		result.EffectivePreset = opts.Preset
	}

	if !opts.ImageFlagChanged {
		if opts.Preset != "" {
			result.BuildPreset = opts.Preset
			result.Image = presetImageName(opts.Preset)
		} else if opts.DefaultBuildPreset != "" {
			result.BuildPreset = opts.DefaultBuildPreset
			result.Image = presetImageName(opts.DefaultBuildPreset)
		}
	}

	if result.BuildPreset != "" && !dockerImageExistsFn(result.Image) {
		contextDir, cleanup, err := writePresetBuildContextFn(result.BuildPreset)
		if err != nil {
			return PresetImageResult{}, err
		}
		defer cleanup()

		dockerfileRelPath := result.BuildPreset + "/Dockerfile"
		fmt.Fprintf(buildMessageWriter, "Building %q preset image (this may take a few minutes)...\n", result.BuildPreset)
		if err := buildDockerImageFn(result.Image, contextDir, dockerfileRelPath); err != nil {
			return PresetImageResult{}, err
		}
	}

	return result, nil
}

func presetImageName(preset string) string {
	if prefix := os.Getenv(presetImagePrefixEnv); prefix != "" {
		return prefix + "-" + preset + ":latest"
	}
	switch preset {
	case "coder":
		return DefaultCoderImage
	default:
		return "amika/" + preset + ":latest"
	}
}

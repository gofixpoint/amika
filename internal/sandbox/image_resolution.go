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
	dockerImageExistsFn             = DockerImageExists
	getPresetDockerfileFn           = GetPresetDockerfile
	buildDockerImageFn              = BuildDockerImage
	buildMessageWriter    io.Writer = os.Stdout
)

// ResolveAndEnsureImage resolves image/preset behavior and auto-builds presets when needed.
func ResolveAndEnsureImage(opts PresetImageOptions) (PresetImageResult, error) {
	if opts.Preset != "" && opts.ImageFlagChanged {
		return PresetImageResult{}, fmt.Errorf("--preset and --image are mutually exclusive")
	}

	result := PresetImageResult{
		Image: opts.Image,
	}

	if opts.Preset != "" {
		result.EffectivePreset = opts.Preset
		result.BuildPreset = opts.Preset
		result.Image = presetImageName(opts.Preset)
	} else if !opts.ImageFlagChanged && opts.DefaultBuildPreset != "" {
		result.BuildPreset = opts.DefaultBuildPreset
		result.Image = presetImageName(opts.DefaultBuildPreset)
	}

	if result.BuildPreset != "" && !dockerImageExistsFn(result.Image) {
		dockerfile, err := getPresetDockerfileFn(result.BuildPreset)
		if err != nil {
			return PresetImageResult{}, err
		}
		fmt.Fprintf(buildMessageWriter, "Building %q preset image (this may take a few minutes)...\n", result.BuildPreset)
		if err := buildDockerImageFn(result.Image, dockerfile); err != nil {
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

package sandbox

import (
	"fmt"
	"io"
	"os"
	"strings"
)

const presetImagePrefixEnv = "AMIKA_PRESET_IMAGE_PREFIX"

// DefaultCoderImage is the default Docker image used for the coder preset.
const DefaultCoderImage = "amika/coder:latest"

// AllowedPresets lists the preset names available for user selection via --preset.
var AllowedPresets = []string{"coder", "coder-dind"}

// AllowedSizes lists the size names available for user selection via --size.
var AllowedSizes = []string{"xs", "m"}

// ValidatePreset returns an error if preset is non-empty and not in AllowedPresets.
func ValidatePreset(preset string) error {
	if preset == "" {
		return nil
	}
	for _, p := range AllowedPresets {
		if preset == p {
			return nil
		}
	}
	return fmt.Errorf("unknown preset %q; allowed presets: %s", preset, strings.Join(AllowedPresets, ", "))
}

// ValidateSize returns an error if size is non-empty and not in AllowedSizes.
func ValidateSize(size string) error {
	if size == "" {
		return nil
	}
	for _, s := range AllowedSizes {
		if size == s {
			return nil
		}
	}
	return fmt.Errorf("unknown size %q; allowed sizes: %s", size, strings.Join(AllowedSizes, ", "))
}

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
	writePresetBuildContextFn           = WritePresetBuildContext
	buildMessageWriter        io.Writer = os.Stdout
)

// ResolveAndEnsureImage resolves image/preset behavior and auto-builds presets when needed.
func ResolveAndEnsureImage(opts PresetImageOptions) (PresetImageResult, error) {
	if err := ValidatePreset(opts.Preset); err != nil {
		return PresetImageResult{}, err
	}

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

		fmt.Fprintf(buildMessageWriter, "Building %q preset image (this may take a few minutes)...\n", result.BuildPreset)
		if err := buildPresetImageFn(result.BuildPreset, contextDir); err != nil {
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

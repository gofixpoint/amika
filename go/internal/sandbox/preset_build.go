package sandbox

import (
	"io"
)

var buildPresetImageFn = BuildPresetImage

var buildDockerImageWithArgsFn = buildDockerImageWithArgs

// BuildPresetImage builds a generated preset image from the shared bundle.
// buildOutput receives the streamed docker build output.
func BuildPresetImage(preset string, contextDir string, buildOutput io.Writer) error {
	if _, err := GetPresetDockerfile(preset); err != nil {
		return err
	}
	return buildDockerImageWithArgsFn(
		presetImageName(preset),
		contextDir,
		"sandbox-image/generated/"+preset+".Dockerfile",
		nil,
		buildOutput,
	)
}

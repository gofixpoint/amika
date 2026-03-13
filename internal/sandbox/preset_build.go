package sandbox

import "fmt"

var buildPresetImageFn = BuildPresetImage

var buildDockerImageWithArgsFn = buildDockerImageWithArgs

// BuildPresetImage builds a preset image and any prerequisite preset images
// needed by its Dockerfile.
func BuildPresetImage(preset string, contextDir string) error {
	buildOrder, err := presetBuildOrder(preset)
	if err != nil {
		return err
	}

	for _, buildPreset := range buildOrder {
		imageName := presetImageName(buildPreset)
		if dockerImageExistsFn(imageName) {
			continue
		}
		if err := buildDockerImageWithArgsFn(imageName, contextDir, buildPreset+"/Dockerfile", presetBuildArgs(buildPreset)); err != nil {
			return err
		}
	}

	return nil
}

func presetBuildOrder(preset string) ([]string, error) {
	switch preset {
	case "base":
		return []string{"base"}, nil
	case "coder":
		return []string{"base", "coder"}, nil
	case "claude":
		return []string{"base", "claude"}, nil
	case "daytona-coder":
		return []string{"base", "coder", "daytona-coder"}, nil
	case "daytona-claude":
		return []string{"base", "claude", "daytona-claude"}, nil
	default:
		return nil, fmt.Errorf("unknown preset %q", preset)
	}
}

func presetBuildArgs(preset string) map[string]string {
	switch preset {
	case "coder", "claude":
		return map[string]string{"BASE_IMAGE": presetImageName("base")}
	case "daytona-coder":
		return map[string]string{"CODER_IMAGE": presetImageName("coder")}
	case "daytona-claude":
		return map[string]string{"CLAUDE_IMAGE": presetImageName("claude")}
	default:
		return nil
	}
}

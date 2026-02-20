package sandbox

import (
	"fmt"
	"os"
	"os/exec"
	"strings"
)

// CreateDockerSandbox creates a long-running Docker container with the given
// name, image, and optional bind mounts. Returns the container ID.
func CreateDockerSandbox(name, image string, mounts []MountBinding, env []string) (string, error) {
	args := []string{"run", "-d", "--name", name}
	for _, m := range mounts {
		vol := m.Source + ":" + m.Target
		if m.Mode == "ro" {
			vol += ":ro"
		}
		args = append(args, "-v", vol)
	}
	for _, e := range env {
		args = append(args, "-e", e)
	}
	args = append(args, image, "tail", "-f", "/dev/null")

	cmd := exec.Command("docker", args...)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("failed to create docker sandbox: %s", strings.TrimSpace(string(out)))
	}
	return strings.TrimSpace(string(out)), nil
}

// DockerImageExists checks if a Docker image exists locally.
func DockerImageExists(name string) bool {
	cmd := exec.Command("docker", "image", "inspect", name)
	return cmd.Run() == nil
}

// BuildDockerImage builds a Docker image from the given Dockerfile content.
func BuildDockerImage(name string, dockerfile []byte) error {
	tmpDir, err := os.MkdirTemp("", "amika-build-*")
	if err != nil {
		return fmt.Errorf("failed to create build context: %w", err)
	}
	defer os.RemoveAll(tmpDir)

	dockerfilePath := tmpDir + "/Dockerfile"
	if err := os.WriteFile(dockerfilePath, dockerfile, 0644); err != nil {
		return fmt.Errorf("failed to write Dockerfile: %w", err)
	}

	cmd := exec.Command("docker", "build", "-t", name, "-f", dockerfilePath, tmpDir)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("failed to build image %q: %w", name, err)
	}
	return nil
}

// RemoveDockerSandbox stops and removes the Docker container with the given name.
func RemoveDockerSandbox(name string) error {
	cmd := exec.Command("docker", "rm", "-f", name)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("failed to remove docker sandbox: %s", strings.TrimSpace(string(out)))
	}
	return nil
}

package sandbox

import (
	"fmt"
	"os/exec"
	"strings"
)

// CreateDockerSandbox creates a long-running Docker container with the given
// name and image. Returns the container ID.
func CreateDockerSandbox(name, image string) (string, error) {
	cmd := exec.Command("docker", "run", "-d", "--name", name, image, "tail", "-f", "/dev/null")
	out, err := cmd.CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("failed to create docker sandbox: %s", strings.TrimSpace(string(out)))
	}
	return strings.TrimSpace(string(out)), nil
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

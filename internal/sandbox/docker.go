package sandbox

import (
	"fmt"
	"os/exec"
	"strings"
)

// CreateDockerSandbox creates a long-running Docker container with the given
// name, image, and optional bind mounts. Returns the container ID.
func CreateDockerSandbox(name, image string, mounts []MountBinding) (string, error) {
	args := []string{"run", "-d", "--name", name}
	for _, m := range mounts {
		vol := m.Source + ":" + m.Target
		if m.Mode == "ro" {
			vol += ":ro"
		}
		args = append(args, "-v", vol)
	}
	args = append(args, image, "tail", "-f", "/dev/null")

	cmd := exec.Command("docker", args...)
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

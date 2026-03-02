// Package sandbox manages sandboxed environments backed by container providers.
package sandbox

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

// CreateDockerSandbox creates a long-running Docker container with the given
// name, image, and optional bind mounts. Returns the container ID.
func CreateDockerSandbox(name, image string, mounts []MountBinding, env []string) (string, error) {
	args := buildDockerRunArgs(name, image, mounts, env)
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

// CreateDockerVolume creates a named docker volume.
func CreateDockerVolume(name string) error {
	cmd := exec.Command("docker", "volume", "create", name)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("failed to create docker volume %q: %s", name, strings.TrimSpace(string(out)))
	}
	return nil
}

// RemoveDockerVolume removes a named docker volume.
func RemoveDockerVolume(name string) error {
	cmd := exec.Command("docker", "volume", "rm", name)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("failed to remove docker volume %q: %s", name, strings.TrimSpace(string(out)))
	}
	return nil
}

// DockerVolumeExists checks if a Docker volume exists locally.
func DockerVolumeExists(name string) bool {
	cmd := exec.Command("docker", "volume", "inspect", name)
	return cmd.Run() == nil
}

// CopyHostDirToVolume copies hostDir contents into the root of volumeName.
//
// Docker named volumes live in Docker-managed storage and are not directly
// accessible from the host filesystem. To populate a volume from host data,
// we spin up a throwaway Alpine container with two mounts: the host directory
// (read-only) and the target volume (read-write). The container runs cp -a to
// copy everything from one to the other, then exits and is removed.
func CopyHostDirToVolume(volumeName, hostDir string) error {
	if hostDir == "" {
		return fmt.Errorf("host directory is required")
	}
	absHostDir, err := filepath.Abs(hostDir)
	if err != nil {
		return fmt.Errorf("failed to resolve host directory %q: %w", hostDir, err)
	}

	cmd := exec.Command(
		"docker", "run", "--rm",
		"-v", absHostDir+":/src:ro",
		"-v", volumeName+":/dst",
		"alpine:3.20",
		"sh", "-c", "cp -a /src/. /dst/",
	)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("failed to copy %q into volume %q: %s", absHostDir, volumeName, strings.TrimSpace(string(out)))
	}
	return nil
}

func buildDockerRunArgs(name, image string, mounts []MountBinding, env []string) []string {
	args := []string{"run", "-d", "--name", name}
	for _, m := range mounts {
		vol := mountVolumeSpec(m)
		if vol == "" {
			continue
		}
		args = append(args, "-v", vol)
	}
	for _, e := range env {
		args = append(args, "-e", e)
	}
	args = append(args, image, "tail", "-f", "/dev/null")
	return args
}

func mountVolumeSpec(m MountBinding) string {
	var src string
	if m.Type == "volume" {
		src = m.Volume
	} else {
		src = m.Source
	}
	if src == "" || m.Target == "" {
		return ""
	}
	vol := src + ":" + m.Target
	if m.Mode == "ro" {
		vol += ":ro"
	}
	return vol
}

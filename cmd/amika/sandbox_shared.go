package main

import (
	"bufio"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/gofixpoint/amika/internal/sandbox"
)

func parseMountFlags(flags []string) ([]sandbox.MountBinding, error) {
	var mounts []sandbox.MountBinding
	seen := make(map[string]bool)

	for _, raw := range flags {
		parts := strings.SplitN(raw, ":", 3)
		if len(parts) < 2 {
			return nil, fmt.Errorf("invalid mount format %q: expected source:target[:mode]", raw)
		}

		source := parts[0]
		target := parts[1]
		mode := "rwcopy"
		if len(parts) == 3 {
			mode = parts[2]
		}

		absSource, err := filepath.Abs(source)
		if err != nil {
			return nil, fmt.Errorf("failed to resolve source path %q: %w", source, err)
		}

		if !strings.HasPrefix(target, "/") {
			return nil, fmt.Errorf("mount target %q must be an absolute path", target)
		}

		if mode != "ro" && mode != "rw" && mode != "rwcopy" {
			return nil, fmt.Errorf("invalid mount mode %q: must be \"ro\", \"rw\", or \"rwcopy\"", mode)
		}

		if seen[target] {
			return nil, fmt.Errorf("duplicate mount target %q", target)
		}
		seen[target] = true

		mounts = append(mounts, sandbox.MountBinding{
			Type:   "bind",
			Source: absSource,
			Target: target,
			Mode:   mode,
		})
	}
	return mounts, nil
}

func formatPortBinding(binding sandbox.PortBinding) string {
	hostIP := binding.HostIP
	if strings.TrimSpace(hostIP) == "" {
		hostIP = "127.0.0.1"
	}
	protocol := binding.Protocol
	if strings.TrimSpace(protocol) == "" {
		protocol = "tcp"
	}
	return fmt.Sprintf("%s:%d->%d/%s", hostIP, binding.HostPort, binding.ContainerPort, protocol)
}

func confirmAction(message string, reader *bufio.Reader) (bool, error) {
	for {
		fmt.Printf("%s [y/n] ", message)
		answer, err := reader.ReadString('\n')
		if err != nil {
			return false, fmt.Errorf("failed to read confirmation: %w", err)
		}
		answer = strings.TrimSpace(strings.ToLower(answer))
		switch answer {
		case "y", "yes":
			return true, nil
		case "n", "no":
			return false, nil
		case "":
			fmt.Println("Please enter 'y' or 'n'.")
		default:
			fmt.Println("Invalid response. Please enter 'y' or 'n'.")
		}
	}
}

func generateRWCopyVolumeName(sandboxName, target string) string {
	sanitizedTarget := strings.NewReplacer("/", "-", "_", "-", ".", "-").Replace(strings.TrimPrefix(target, "/"))
	if sanitizedTarget == "" {
		sanitizedTarget = "root"
	}
	return "amika-rwcopy-" + sandboxName + "-" + sanitizedTarget + "-" + strconv.FormatInt(time.Now().UnixNano(), 10)
}

func copyFile(src, dst string) error {
	srcInfo, err := os.Stat(src)
	if err != nil {
		return fmt.Errorf("failed to stat source file %q: %w", src, err)
	}
	data, err := os.ReadFile(src)
	if err != nil {
		return fmt.Errorf("failed to read source file %q: %w", src, err)
	}
	if err := os.WriteFile(dst, data, srcInfo.Mode()); err != nil {
		return fmt.Errorf("failed to write destination file %q: %w", dst, err)
	}
	return nil
}

func hasEnvKey(env []string, key string) bool {
	prefix := key + "="
	for _, e := range env {
		if strings.HasPrefix(e, prefix) {
			return true
		}
	}
	return false
}

func appendPresetRuntimeEnv(env []string) []string {
	for _, key := range []string{"OPENCODE_SERVER_PASSWORD", "AMIKA_OPENCODE_WEB"} {
		if hasEnvKey(env, key) {
			continue
		}
		if value, ok := os.LookupEnv(key); ok {
			env = append(env, key+"="+value)
		}
	}
	return env
}

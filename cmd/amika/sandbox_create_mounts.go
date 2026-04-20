package main

import (
	"fmt"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/gofixpoint/amika/internal/sandbox"
	"github.com/gofixpoint/amika/pkg/amika"
)

// parsePortFlags parses --port flag values in the format hostPort:containerPort[/protocol].
func parsePortFlags(flags []string, hostIP string) ([]sandbox.PortBinding, error) {
	hostIP = strings.TrimSpace(hostIP)
	if hostIP == "" {
		return nil, fmt.Errorf("--port-host-ip must not be empty")
	}

	ports := make([]sandbox.PortBinding, 0, len(flags))
	seen := make(map[string]bool, len(flags))
	for _, raw := range flags {
		value := strings.TrimSpace(raw)
		if value == "" {
			return nil, fmt.Errorf("invalid port format %q: expected hostPort:containerPort[/protocol]", raw)
		}

		mainPart := value
		protocol := "tcp"
		if strings.Contains(value, "/") {
			parts := strings.SplitN(value, "/", 2)
			mainPart = parts[0]
			protocol = strings.ToLower(strings.TrimSpace(parts[1]))
		}
		if protocol != "tcp" && protocol != "udp" {
			return nil, fmt.Errorf("invalid port protocol %q: must be \"tcp\" or \"udp\"", protocol)
		}

		parts := strings.SplitN(mainPart, ":", 2)
		if len(parts) != 2 {
			return nil, fmt.Errorf("invalid port format %q: expected hostPort:containerPort[/protocol]", raw)
		}
		hostPort, err := strconv.Atoi(strings.TrimSpace(parts[0]))
		if err != nil {
			return nil, fmt.Errorf("invalid host port in %q: %w", raw, err)
		}
		containerPort, err := strconv.Atoi(strings.TrimSpace(parts[1]))
		if err != nil {
			return nil, fmt.Errorf("invalid container port in %q: %w", raw, err)
		}
		if hostPort < 1 || hostPort > 65535 {
			return nil, fmt.Errorf("host port %d must be between 1 and 65535", hostPort)
		}
		if containerPort < 1 || containerPort > 65535 {
			return nil, fmt.Errorf("container port %d must be between 1 and 65535", containerPort)
		}

		key := fmt.Sprintf("%s:%d/%s", hostIP, hostPort, protocol)
		if seen[key] {
			return nil, fmt.Errorf("duplicate published port binding %s", key)
		}
		seen[key] = true
		ports = append(ports, sandbox.PortBinding{
			HostIP:        hostIP,
			HostPort:      hostPort,
			ContainerPort: containerPort,
			Protocol:      protocol,
		})
	}
	return ports, nil
}

func formatPortBindings(bindings []amika.PortBinding) string {
	if len(bindings) == 0 {
		return "-"
	}
	out := make([]string, 0, len(bindings))
	for _, p := range bindings {
		hostIP := p.HostIP
		if strings.TrimSpace(hostIP) == "" {
			hostIP = "127.0.0.1"
		}
		protocol := p.Protocol
		if strings.TrimSpace(protocol) == "" {
			protocol = "tcp"
		}
		out = append(out, fmt.Sprintf("%s:%d->%d/%s", hostIP, p.HostPort, p.ContainerPort, protocol))
	}
	return strings.Join(out, ",")
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

// parseMountFlags parses --mount flag values in the format source:target[:mode].
// Mode defaults to "rwcopy" if omitted.
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

// parseVolumeFlags parses --volume flag values in the format name:target[:mode].
// Mode defaults to "rw" if omitted.
func parseVolumeFlags(flags []string) ([]sandbox.MountBinding, error) {
	var mounts []sandbox.MountBinding
	seen := make(map[string]bool)

	for _, raw := range flags {
		parts := strings.SplitN(raw, ":", 3)
		if len(parts) < 2 {
			return nil, fmt.Errorf("invalid volume format %q: expected name:target[:mode]", raw)
		}

		name := strings.TrimSpace(parts[0])
		target := parts[1]
		mode := "rw"
		if len(parts) == 3 {
			mode = parts[2]
		}

		if name == "" {
			return nil, fmt.Errorf("volume name must not be empty in %q", raw)
		}
		if !strings.HasPrefix(target, "/") {
			return nil, fmt.Errorf("mount target %q must be an absolute path", target)
		}
		if mode != "ro" && mode != "rw" {
			return nil, fmt.Errorf("invalid volume mount mode %q: must be \"ro\" or \"rw\"", mode)
		}
		if seen[target] {
			return nil, fmt.Errorf("duplicate mount target %q", target)
		}
		seen[target] = true

		mounts = append(mounts, sandbox.MountBinding{
			Type:   "volume",
			Volume: name,
			Target: target,
			Mode:   mode,
		})
	}
	return mounts, nil
}

// parseSecretFlags parses --secret flag values into a map of env var name → secret name.
// Supported syntax:
//   - env:FOO=SECRET_NAME — inject secret SECRET_NAME as env var FOO
//   - env:SECRET_NAME     — shorthand: env var name equals the secret name
func parseSecretFlags(flags []string) (map[string]string, error) {
	if len(flags) == 0 {
		return nil, nil
	}
	result := make(map[string]string, len(flags))

	for _, raw := range flags {
		idx := strings.Index(raw, ":")
		if idx < 0 {
			return nil, fmt.Errorf("invalid --secret format %q: expected type prefix (e.g. env:SECRET_NAME or env:FOO=SECRET_NAME)", raw)
		}

		prefix := raw[:idx]
		value := raw[idx+1:]

		switch prefix {
		case "file":
			return nil, fmt.Errorf("file: secret type is not yet supported")
		case "env":
		default:
			return nil, fmt.Errorf("unknown secret type %q in %q: supported types are \"env\"", prefix, raw)
		}

		var envVar, secretName string
		if eqIdx := strings.Index(value, "="); eqIdx >= 0 {
			envVar = value[:eqIdx]
			secretName = value[eqIdx+1:]
		} else {
			envVar = value
			secretName = value
		}

		if envVar == "" {
			return nil, fmt.Errorf("empty env var name in --secret %q", raw)
		}
		if secretName == "" {
			return nil, fmt.Errorf("empty secret name in --secret %q", raw)
		}
		if _, dup := result[envVar]; dup {
			return nil, fmt.Errorf("duplicate env var %q in --secret flags", envVar)
		}

		result[envVar] = secretName
	}
	return result, nil
}

// parseEnvVarFlags parses --env flag values (KEY=VALUE) into a map.
func parseEnvVarFlags(flags []string) (map[string]string, error) {
	if len(flags) == 0 {
		return nil, nil
	}
	envVars := make(map[string]string, len(flags))
	for _, raw := range flags {
		eqIdx := strings.Index(raw, "=")
		if eqIdx < 0 {
			return nil, fmt.Errorf("invalid --env format %q: expected KEY=VALUE", raw)
		}
		key := raw[:eqIdx]
		val := raw[eqIdx+1:]
		if key == "" {
			return nil, fmt.Errorf("empty key in --env %q", raw)
		}
		envVars[key] = val
	}
	return envVars, nil
}

func validateMountTargets(bindMounts, volumeMounts []sandbox.MountBinding) error {
	seen := make(map[string]bool, len(bindMounts)+len(volumeMounts))
	for _, m := range bindMounts {
		seen[m.Target] = true
	}
	for _, m := range volumeMounts {
		if seen[m.Target] {
			return fmt.Errorf("duplicate mount target %q", m.Target)
		}
		seen[m.Target] = true
	}
	return nil
}

func validateGitFlags(gitEnabled, noClean bool) error {
	if noClean && !gitEnabled {
		return fmt.Errorf("--no-clean requires --git")
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

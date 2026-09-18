package sandboxcmd

// sandbox_create_mounts.go parses the rig-creation flags that are forwarded to
// the API (--secret, --env) and formats the repo banner and the port column
// shared by `rig create` and `rig list`.

import (
	"fmt"
	"strings"

	"github.com/gofixpoint/amika/go/internal/gitrepo"
	"github.com/gofixpoint/amika/go/pkg/amika"
)

func formatPortBindings(bindings []amika.PortBinding) string {
	if len(bindings) == 0 {
		return "-"
	}
	out := make([]string, 0, len(bindings))
	for _, p := range bindings {
		protocol := p.Protocol
		if strings.TrimSpace(protocol) == "" {
			protocol = "tcp"
		}
		// Remote sandboxes have no host IP (services are reached via generated
		// URLs), so omit the "host:" prefix rather than print a misleading
		// localhost. Local sandboxes always carry an explicit HostIP.
		if strings.TrimSpace(p.HostIP) == "" {
			out = append(out, fmt.Sprintf("%d->%d/%s", p.HostPort, p.ContainerPort, protocol))
			continue
		}
		out = append(out, fmt.Sprintf("%s:%d->%d/%s", p.HostIP, p.HostPort, p.ContainerPort, protocol))
	}
	return strings.Join(out, ",")
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

func formatRepoBanner(identity gitrepo.Identity) string {
	if identity.Source == gitrepo.SourceNone {
		return "Creating a bare sandbox with no repos."
	}
	return fmt.Sprintf("Creating sandbox with repo %s.", identity.Name)
}

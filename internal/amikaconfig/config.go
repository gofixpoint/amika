// Package amikaconfig loads Amika configuration from global and repo config files.
package amikaconfig

import (
	"errors"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"

	"github.com/BurntSushi/toml"
	"github.com/gofixpoint/amika/internal/constants"
)

// Config is the parsed Amika config file.
type Config struct {
	API       APIConfig                `toml:"api"`
	Lifecycle LifecycleConfig          `toml:"lifecycle"`
	Services  map[string]ServiceConfig `toml:"services"`
}

// APIConfig holds API client configuration.
type APIConfig struct {
	APIURL       string `toml:"api_url"`
	AuthClientID string `toml:"auth_client_id"`
}

// LifecycleConfig holds sandbox lifecycle hooks.
type LifecycleConfig struct {
	// SetupScript is the path to an executable to mount at /usr/local/etc/amikad/setup/setup.sh.
	// Relative paths are resolved from the repo root.
	SetupScript string `toml:"setup_script"`
}

// ServiceConfig is the raw TOML representation of a service declaration.
type ServiceConfig struct {
	Port      interface{}   `toml:"port"`
	Ports     []interface{} `toml:"ports"`
	URLScheme interface{}   `toml:"url_scheme"`
}

// ServicePortParsed is a normalized port with its resolved URL scheme.
type ServicePortParsed struct {
	ContainerPort int
	Protocol      string // "tcp" or "udp"
	URLScheme     string // "" (no URL), "http", or "https"
}

// ServiceParsed is a validated, normalized service definition.
type ServiceParsed struct {
	Name  string
	Ports []ServicePortParsed
}

// LoadConfig reads $repoRoot/.amika/config.toml.
// Returns nil, nil if the file does not exist.
func LoadConfig(repoRoot string) (*Config, error) {
	path := filepath.Join(repoRoot, ".amika", "config.toml")
	data, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, nil
		}
		return nil, err
	}
	var cfg Config
	if err := toml.Unmarshal(data, &cfg); err != nil {
		return nil, fmt.Errorf("parsing %s: %w", path, err)
	}
	return &cfg, nil
}

// ParsedServices validates the service declarations and returns a normalized list.
// Returns nil, nil when no services are declared.
func (c *Config) ParsedServices() ([]ServiceParsed, error) {
	if len(c.Services) == 0 {
		return nil, nil
	}
	if err := ValidateServices(c.Services); err != nil {
		return nil, err
	}

	// Sort service names for deterministic output.
	names := make([]string, 0, len(c.Services))
	for name := range c.Services {
		names = append(names, name)
	}
	sort.Strings(names)

	var result []ServiceParsed
	for _, name := range names {
		svc := c.Services[name]
		parsed, err := parseServiceConfig(name, svc)
		if err != nil {
			return nil, err
		}
		result = append(result, parsed)
	}
	return result, nil
}

// ValidateServices checks all service declarations for correctness.
func ValidateServices(services map[string]ServiceConfig) error {
	// Global duplicate check: containerPort/protocol across all services.
	globalPorts := make(map[string]string) // "port/proto" -> service name

	for name, svc := range services {
		hasPort := svc.Port != nil
		hasPorts := len(svc.Ports) > 0
		if hasPort && hasPorts {
			return fmt.Errorf("service %q: port and ports are mutually exclusive", name)
		}

		// A service with neither port nor ports is valid (metadata-only).
		if !hasPort && !hasPorts {
			continue
		}

		// Collect and validate port values.
		var rawPorts []interface{}
		if hasPort {
			rawPorts = []interface{}{svc.Port}
		} else {
			rawPorts = svc.Ports
		}

		localPorts := make(map[string]bool)
		for _, raw := range rawPorts {
			cp, proto, err := parsePort(raw)
			if err != nil {
				return fmt.Errorf("service %q: %w", name, err)
			}
			key := fmt.Sprintf("%d/%s", cp, proto)
			if localPorts[key] {
				return fmt.Errorf("service %q: duplicate port %s", name, key)
			}
			localPorts[key] = true
			if prev, ok := globalPorts[key]; ok {
				return fmt.Errorf("duplicate port %s across services %q and %q", key, prev, name)
			}
			globalPorts[key] = name
		}

		// Validate url_scheme.
		if svc.URLScheme != nil {
			if err := validateURLScheme(name, svc, localPorts); err != nil {
				return err
			}
		}
	}
	return nil
}

// parsePort parses a port value (int64 or "port/proto" string) into container port and protocol.
func parsePort(v interface{}) (int, string, error) {
	switch val := v.(type) {
	case int64:
		return validatePortNumber(int(val), "tcp")
	case float64:
		if val != math.Trunc(val) {
			return 0, "", fmt.Errorf("invalid port %v: must be an integer", val)
		}
		return validatePortNumber(int(val), "tcp")
	case string:
		parts := strings.SplitN(val, "/", 2)
		if len(parts) != 2 {
			return 0, "", fmt.Errorf("invalid port format %q: expected \"port/protocol\"", val)
		}
		port, err := strconv.Atoi(strings.TrimSpace(parts[0]))
		if err != nil {
			return 0, "", fmt.Errorf("invalid port number in %q: %w", val, err)
		}
		proto := strings.ToLower(strings.TrimSpace(parts[1]))
		return validatePortNumber(port, proto)
	default:
		return 0, "", fmt.Errorf("invalid port value %v (type %T): must be an integer or \"port/protocol\" string", v, v)
	}
}

func validatePortNumber(port int, proto string) (int, string, error) {
	if port < 1 || port > 65535 {
		return 0, "", fmt.Errorf("port %d must be between 1 and 65535", port)
	}
	if proto != "tcp" && proto != "udp" {
		return 0, "", fmt.Errorf("invalid protocol %q: must be \"tcp\" or \"udp\"", proto)
	}
	if port >= constants.ReservedPortStart && port <= constants.ReservedPortEnd {
		return 0, "", fmt.Errorf("port %d is in the reserved range %d-%d", port, constants.ReservedPortStart, constants.ReservedPortEnd)
	}
	return port, proto, nil
}

func validateURLScheme(name string, svc ServiceConfig, localPorts map[string]bool) error {
	hasPort := svc.Port != nil

	// Single-port with a simple string url_scheme.
	if hasPort {
		if scheme, ok := svc.URLScheme.(string); ok {
			if scheme != "http" && scheme != "https" {
				return fmt.Errorf("service %q: url_scheme %q must be \"http\" or \"https\"", name, scheme)
			}
			return nil
		}
		// Single port may also use list-form url_scheme, but only as [] or [{port=<same>, scheme=...}].
	}

	// List-form url_scheme: valid with both port and ports.
	list, ok := svc.URLScheme.([]interface{})
	if !ok {
		if _, isStr := svc.URLScheme.(string); isStr {
			return fmt.Errorf("service %q: url_scheme must be a list of {port, scheme} mappings when using ports (not a string)", name)
		}
		return fmt.Errorf("service %q: invalid url_scheme format", name)
	}

	var singlePortKey string
	if hasPort {
		cp, proto, err := parsePort(svc.Port)
		if err != nil {
			return fmt.Errorf("service %q: %w", name, err)
		}
		singlePortKey = fmt.Sprintf("%d/%s", cp, proto)
		if len(list) > 1 {
			return fmt.Errorf("service %q: url_scheme list may contain at most one entry when using port", name)
		}
	}

	seen := make(map[string]bool)
	for _, item := range list {
		mapping, ok := item.(map[string]interface{})
		if !ok {
			return fmt.Errorf("service %q: each url_scheme entry must be a {port, scheme} table", name)
		}
		portVal, hasP := mapping["port"]
		schemeVal, hasS := mapping["scheme"]
		if !hasP || !hasS {
			return fmt.Errorf("service %q: each url_scheme entry must have port and scheme fields", name)
		}
		scheme, ok := schemeVal.(string)
		if !ok || (scheme != "http" && scheme != "https") {
			return fmt.Errorf("service %q: url_scheme scheme %q must be \"http\" or \"https\"", name, schemeVal)
		}
		cp, proto, err := parsePort(portVal)
		if err != nil {
			return fmt.Errorf("service %q: url_scheme port: %w", name, err)
		}
		key := fmt.Sprintf("%d/%s", cp, proto)
		if !localPorts[key] {
			return fmt.Errorf("service %q: url_scheme references undeclared port %s", name, key)
		}
		if hasPort && key != singlePortKey {
			return fmt.Errorf("service %q: url_scheme port %s must match declared port %s", name, key, singlePortKey)
		}
		if seen[key] {
			return fmt.Errorf("service %q: duplicate port %s in url_scheme", name, key)
		}
		seen[key] = true
	}
	return nil
}

// parseServiceConfig converts a validated ServiceConfig into a ServiceParsed.
func parseServiceConfig(name string, svc ServiceConfig) (ServiceParsed, error) {
	hasPort := svc.Port != nil
	hasPorts := len(svc.Ports) > 0

	// No ports declared — return a metadata-only service.
	if !hasPort && !hasPorts {
		return ServiceParsed{Name: name}, nil
	}

	// Build url_scheme lookup.
	schemeMap := make(map[string]string) // "port/proto" -> scheme
	if svc.URLScheme != nil {
		if scheme, ok := svc.URLScheme.(string); ok {
			// Simple string form — only valid with single port.
			cp, proto, _ := parsePort(svc.Port)
			schemeMap[fmt.Sprintf("%d/%s", cp, proto)] = scheme
		} else if list, ok := svc.URLScheme.([]interface{}); ok {
			// List form — valid with both port and ports.
			for _, item := range list {
				mapping := item.(map[string]interface{})
				cp, proto, _ := parsePort(mapping["port"])
				schemeMap[fmt.Sprintf("%d/%s", cp, proto)] = mapping["scheme"].(string)
			}
		}
	}

	// Parse ports.
	var rawPorts []interface{}
	if hasPort {
		rawPorts = []interface{}{svc.Port}
	} else {
		rawPorts = svc.Ports
	}

	ports := make([]ServicePortParsed, 0, len(rawPorts))
	for _, raw := range rawPorts {
		cp, proto, _ := parsePort(raw)
		key := fmt.Sprintf("%d/%s", cp, proto)
		ports = append(ports, ServicePortParsed{
			ContainerPort: cp,
			Protocol:      proto,
			URLScheme:     schemeMap[key],
		})
	}

	return ServiceParsed{Name: name, Ports: ports}, nil
}

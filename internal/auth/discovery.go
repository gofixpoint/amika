package auth

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

var envStyleAPIKeyPattern = regexp.MustCompile(`(?i)^([A-Z0-9_-]+)_API_KEY$`)

type credentialSource struct {
	precedence int
	oauth      bool
	files      []string
}

type candidate struct {
	value      string
	precedence int
}

// Discover scans known local credential sources and returns deduplicated results.
func Discover(opts Options) (CredentialSet, error) {
	homeDir := opts.HomeDir
	if homeDir == "" {
		var err error
		homeDir, err = os.UserHomeDir()
		if err != nil {
			return CredentialSet{}, fmt.Errorf("failed to get home directory: %w", err)
		}
	}

	winners := make(map[string]candidate)
	for _, src := range configuredSources(homeDir) {
		if src.oauth && !opts.IncludeOAuth {
			continue
		}
		for _, path := range src.files {
			found, err := collectFileCredentials(path, src.precedence, winners)
			if err != nil {
				return CredentialSet{}, err
			}
			if !found {
				continue
			}
		}
	}

	result := CredentialSet{Other: make(map[string]string)}
	for provider, winner := range winners {
		switch provider {
		case "anthropic":
			result.Anthropic = winner.value
		case "openai":
			result.OpenAI = winner.value
		default:
			result.Other[provider] = winner.value
		}
	}
	if len(result.Other) == 0 {
		result.Other = nil
	}

	return result, nil
}

func configuredSources(homeDir string) []credentialSource {
	return []credentialSource{
		{
			precedence: 4,
			files: []string{
				filepath.Join(homeDir, ".claude.json"),
				filepath.Join(homeDir, ".config", "claude", "config.json"),
				filepath.Join(homeDir, ".config", "claude", "credentials.json"),
				filepath.Join(homeDir, ".codex", "auth.json"),
				filepath.Join(homeDir, ".config", "codex", "auth.json"),
				filepath.Join(homeDir, ".config", "opencode", "auth.json"),
				filepath.Join(homeDir, ".config", "amp", "config.json"),
				filepath.Join(homeDir, ".config", "pi", "config.json"),
			},
		},
		{
			precedence: 3,
			files: []string{
				filepath.Join(homeDir, ".amika", "env-cache.json"),
				filepath.Join(homeDir, ".cache", "amika", "env-cache.json"),
			},
		},
		{
			precedence: 2,
			files: []string{
				filepath.Join(homeDir, ".config", "amika", "keychain.json"),
			},
		},
		{
			oauth:      true,
			precedence: 1,
			files: []string{
				filepath.Join(homeDir, ".config", "amika", "oauth.json"),
				filepath.Join(homeDir, ".local", "share", "amika", "oauth.json"),
			},
		},
	}
}

func collectFileCredentials(path string, precedence int, winners map[string]candidate) (bool, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return false, nil
		}
		return false, fmt.Errorf("failed to read credentials file %q: %w", path, err)
	}

	var payload any
	if err := json.Unmarshal(data, &payload); err != nil {
		return false, fmt.Errorf("failed to parse credentials file %q: %w", path, err)
	}

	hits := collectCredentials(payload, "")
	for provider, value := range hits {
		provider = canonicalProvider(provider)
		if provider == "" || value == "" {
			continue
		}
		if current, ok := winners[provider]; ok && current.precedence >= precedence {
			continue
		}
		winners[provider] = candidate{value: value, precedence: precedence}
	}
	return true, nil
}

func collectCredentials(node any, providerHint string) map[string]string {
	out := make(map[string]string)
	walk(node, canonicalProvider(providerHint), out)
	return out
}

func walk(node any, providerHint string, out map[string]string) {
	switch v := node.(type) {
	case map[string]any:
		for key, raw := range v {
			keyLower := strings.ToLower(strings.TrimSpace(key))

			if provider, ok := providerFromEnvStyleKey(key); ok {
				if value := stringValue(raw); value != "" {
					out[provider] = value
				}
			}

			nextHint := providerHint
			if inferred := canonicalProvider(keyLower); inferred != "" {
				nextHint = inferred
			}
			if isGenericSecretKey(keyLower) {
				if value := stringValue(raw); value != "" && providerHint != "" {
					out[providerHint] = value
				}
			}

			walk(raw, nextHint, out)
		}
	case []any:
		for _, item := range v {
			walk(item, providerHint, out)
		}
	}
}

func providerFromEnvStyleKey(key string) (string, bool) {
	m := envStyleAPIKeyPattern.FindStringSubmatch(strings.TrimSpace(key))
	if len(m) != 2 {
		return "", false
	}
	provider := canonicalProvider(strings.ToLower(m[1]))
	if provider == "" {
		return "", false
	}
	return provider, true
}

func isGenericSecretKey(key string) bool {
	switch key {
	case "api_key", "apikey", "api-key", "token", "access_token":
		return true
	default:
		return false
	}
}

func stringValue(v any) string {
	s, ok := v.(string)
	if !ok {
		return ""
	}
	return strings.TrimSpace(s)
}

func canonicalProvider(name string) string {
	name = strings.TrimSpace(strings.ToLower(name))
	if name == "" {
		return ""
	}

	replacer := strings.NewReplacer("_", "-", " ", "-", ".", "-", "/", "-", "--", "-")
	name = replacer.Replace(name)
	name = strings.Trim(name, "-")

	switch name {
	case "claude", "anthropic":
		return "anthropic"
	case "codex", "openai":
		return "openai"
	default:
		return name
	}
}

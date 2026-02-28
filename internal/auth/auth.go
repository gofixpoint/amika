package auth

import (
	"fmt"
	"sort"
	"strings"
)

// CredentialSet contains discovered credentials by canonical provider buckets.
type CredentialSet struct {
	Anthropic string
	OpenAI    string
	Other     map[string]string
}

// Options controls credential discovery behavior.
type Options struct {
	HomeDir      string
	IncludeOAuth bool
}

// NormalizeProviderName normalizes provider names to uppercase env-safe names.
func NormalizeProviderName(provider string) string {
	provider = strings.TrimSpace(strings.ToUpper(provider))
	provider = strings.ReplaceAll(provider, "-", "_")
	return provider
}

// BuildEnvMap converts discovered credentials into environment variables.
func BuildEnvMap(result CredentialSet) map[string]string {
	env := make(map[string]string)

	if result.Anthropic != "" {
		env["ANTHROPIC_API_KEY"] = result.Anthropic
		env["CLAUDE_API_KEY"] = result.Anthropic
	}
	if result.OpenAI != "" {
		env["OPENAI_API_KEY"] = result.OpenAI
		env["CODEX_API_KEY"] = result.OpenAI
	}
	for provider, value := range result.Other {
		if value == "" {
			continue
		}
		key := fmt.Sprintf("%s_API_KEY", NormalizeProviderName(provider))
		env[key] = value
	}

	return env
}

// RenderEnvLines renders sorted shell-safe environment assignment lines.
func RenderEnvLines(env map[string]string, withExport bool) []string {
	keys := make([]string, 0, len(env))
	for k, v := range env {
		if v == "" {
			continue
		}
		keys = append(keys, k)
	}
	sort.Strings(keys)

	lines := make([]string, 0, len(keys))
	for _, key := range keys {
		assignment := fmt.Sprintf("%s=%s", key, shellQuote(env[key]))
		if withExport {
			assignment = "export " + assignment
		}
		lines = append(lines, assignment)
	}
	return lines
}

func shellQuote(value string) string {
	if value == "" {
		return "''"
	}
	return "'" + strings.ReplaceAll(value, "'", "'\\''") + "'"
}

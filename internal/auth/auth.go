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

// EnvVars encapsulates environment variable storage and rendering.
type EnvVars interface {
	Set(key, value string)
	Get(key string) (string, bool)
	Len() int
	SortedKeys() []string
	Lines(withExport bool) []string
}

type envVars struct {
	values map[string]string
}

// NewEnvVars creates an EnvVars instance backed by an internal map.
func NewEnvVars() EnvVars {
	return &envVars{
		values: make(map[string]string),
	}
}

// NormalizeProviderName normalizes provider names to uppercase env-safe names.
func NormalizeProviderName(provider string) string {
	provider = strings.TrimSpace(strings.ToUpper(provider))
	provider = strings.ReplaceAll(provider, "-", "_")
	return provider
}

// BuildEnvMap converts discovered credentials into environment variables.
func BuildEnvMap(result CredentialSet) EnvVars {
	env := NewEnvVars()

	if result.Anthropic != "" {
		env.Set("ANTHROPIC_API_KEY", result.Anthropic)
		env.Set("CLAUDE_API_KEY", result.Anthropic)
	}
	if result.OpenAI != "" {
		env.Set("OPENAI_API_KEY", result.OpenAI)
		env.Set("CODEX_API_KEY", result.OpenAI)
	}
	for provider, value := range result.Other {
		if value == "" {
			continue
		}
		key := fmt.Sprintf("%s_API_KEY", NormalizeProviderName(provider))
		env.Set(key, value)
	}

	return env
}

func (e *envVars) Set(key, value string) {
	if value == "" {
		delete(e.values, key)
		return
	}
	e.values[key] = value
}

func (e *envVars) Get(key string) (string, bool) {
	v, ok := e.values[key]
	return v, ok
}

func (e *envVars) Len() int {
	return len(e.values)
}

func (e *envVars) SortedKeys() []string {
	keys := make([]string, 0, len(e.values))
	for k, v := range e.values {
		if v == "" {
			continue
		}
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

func (e *envVars) Lines(withExport bool) []string {
	keys := e.SortedKeys()
	lines := make([]string, 0, len(keys))
	for _, key := range keys {
		value, _ := e.Get(key)
		assignment := fmt.Sprintf("%s=%s", key, shellQuote(value))
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

package auth

import (
	"encoding/json"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/gofixpoint/amika/internal/basedir"
)

type sourceDef struct {
	id       string
	priority int
	oauth    bool
	parse    func(homeDir string, includeOAuth bool, now time.Time, paths basedir.Paths) (map[string]string, error)
}

type candidate struct {
	value    string
	priority int
	order    int
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

	now := time.Now().UTC()
	paths := basedir.New(homeDir)
	winners := make(map[string]candidate)

	for order, src := range configuredSources() {
		if src.oauth && !opts.IncludeOAuth {
			continue
		}

		hits, err := src.parse(homeDir, opts.IncludeOAuth, now, paths)
		if err != nil {
			return CredentialSet{}, fmt.Errorf("%s discovery failed: %w", src.id, err)
		}

		for provider, value := range hits {
			provider = canonicalProvider(provider)
			value = strings.TrimSpace(value)
			if provider == "" || value == "" {
				continue
			}

			current, ok := winners[provider]
			if ok {
				if current.priority > src.priority {
					continue
				}
				if current.priority == src.priority && current.order <= order {
					continue
				}
			}

			winners[provider] = candidate{value: value, priority: src.priority, order: order}
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

func configuredSources() []sourceDef {
	return []sourceDef{
		{id: "claude_api", priority: 500, parse: parseClaudeAPI},
		{id: "claude_oauth", priority: 400, oauth: true, parse: parseClaudeOAuth},
		{id: "codex", priority: 300, parse: parseCodex},
		{id: "amika_env_cache", priority: 290, parse: parseAmikaEnvCache},
		{id: "amika_keychain", priority: 280, parse: parseAmikaKeychain},
		{id: "amika_oauth", priority: 270, oauth: true, parse: parseAmikaOAuth},
		{id: "opencode", priority: 200, parse: parseOpenCode},
		{id: "amp", priority: 100, parse: parseAmp},
	}
}

func parseClaudeAPI(homeDir string, _ bool, _ time.Time, _ basedir.Paths) (map[string]string, error) {
	paths := make([]string, len(ClaudeAPIKeyPaths()))
	for i, p := range ClaudeAPIKeyPaths() {
		paths[i] = filepath.Join(homeDir, p)
	}
	fields := []string{"primaryApiKey", "apiKey", "anthropicApiKey", "customApiKey"}

	for _, path := range paths {
		obj, found, err := readJSONObjectIfExists(path)
		if err != nil {
			return nil, err
		}
		if !found {
			continue
		}

		for _, field := range fields {
			value, exists, err := getStringPath(obj, field)
			if err != nil {
				return nil, fmt.Errorf("failed to parse credentials file %q: %w", path, err)
			}
			if !exists || value == "" {
				continue
			}
			if strings.HasPrefix(value, "sk-ant-") {
				return map[string]string{"anthropic": value}, nil
			}
		}
	}

	return nil, nil
}

func parseClaudeOAuth(homeDir string, includeOAuth bool, now time.Time, _ basedir.Paths) (map[string]string, error) {
	if !includeOAuth {
		return nil, nil
	}

	paths := make([]string, len(ClaudeOAuthPaths()))
	for i, p := range ClaudeOAuthPaths() {
		paths[i] = filepath.Join(homeDir, p)
	}

	for _, path := range paths {
		obj, found, err := readJSONObjectIfExists(path)
		if err != nil {
			return nil, err
		}
		if !found {
			continue
		}

		token, exists, err := getStringPath(obj, "claudeAiOauth.accessToken")
		if err != nil {
			return nil, fmt.Errorf("failed to parse credentials file %q: %w", path, err)
		}
		if !exists || token == "" {
			continue
		}

		expiresTime, hasExpiry, err := parseClaudeOAuthExpiry(obj)
		if err != nil {
			return nil, fmt.Errorf("failed to parse credentials file %q: %w", path, err)
		}
		if hasExpiry && !expiresTime.After(now) {
			continue
		}

		return map[string]string{"anthropic": token}, nil
	}

	return nil, nil
}

// parseClaudeOAuthExpiry extracts claudeAiOauth.expiresAt from the parsed
// credentials object, handling both RFC 3339 strings (legacy) and numeric
// epoch-millisecond values (current).
func parseClaudeOAuthExpiry(obj map[string]any) (time.Time, bool, error) {
	raw, found := getValuePath(obj, "claudeAiOauth.expiresAt")
	if !found || raw == nil {
		return time.Time{}, false, nil
	}

	switch v := raw.(type) {
	case string:
		v = strings.TrimSpace(v)
		if v == "" {
			return time.Time{}, false, nil
		}
		t, err := time.Parse(time.RFC3339, v)
		if err != nil {
			return time.Time{}, false, fmt.Errorf("invalid claudeAiOauth.expiresAt: %w", err)
		}
		return t, true, nil
	default:
		ms, err := parseEpochMillis(raw)
		if err != nil {
			return time.Time{}, false, fmt.Errorf("invalid claudeAiOauth.expiresAt: %w", err)
		}
		return time.UnixMilli(ms), true, nil
	}
}

// getValuePath navigates a dot-separated path into a nested JSON object and
// returns the raw value at the leaf. It returns (nil, false) when any
// intermediate key is missing.
func getValuePath(obj map[string]any, path string) (any, bool) {
	parts := strings.Split(path, ".")
	var current any = obj

	for i, part := range parts {
		if current == nil {
			return nil, false
		}
		m, ok := current.(map[string]any)
		if !ok {
			return nil, false
		}
		raw, exists := m[part]
		if !exists {
			return nil, false
		}
		if i == len(parts)-1 {
			return raw, true
		}
		current = raw
	}
	return nil, false
}

func parseCodex(homeDir string, includeOAuth bool, _ time.Time, _ basedir.Paths) (map[string]string, error) {
	path := filepath.Join(homeDir, ".codex", "auth.json")
	obj, found, err := readJSONObjectIfExists(path)
	if err != nil {
		return nil, err
	}
	if !found {
		return nil, nil
	}

	apiKey, exists, err := getStringPath(obj, "OPENAI_API_KEY")
	if err != nil {
		return nil, fmt.Errorf("failed to parse credentials file %q: %w", path, err)
	}
	if exists && apiKey != "" {
		return map[string]string{"openai": apiKey}, nil
	}

	if includeOAuth {
		token, exists, err := getStringPath(obj, "tokens.access_token")
		if err != nil {
			return nil, fmt.Errorf("failed to parse credentials file %q: %w", path, err)
		}
		if exists && token != "" {
			return map[string]string{"openai": token}, nil
		}
	}

	return nil, nil
}

func parseOpenCode(homeDir string, includeOAuth bool, now time.Time, _ basedir.Paths) (map[string]string, error) {
	path := filepath.Join(homeDir, ".local", "share", "opencode", "auth.json")
	obj, found, err := readJSONObjectIfExists(path)
	if err != nil {
		return nil, err
	}
	if !found {
		return nil, nil
	}

	providerNames := make([]string, 0, len(obj))
	for provider := range obj {
		providerNames = append(providerNames, provider)
	}
	sort.Strings(providerNames)

	result := make(map[string]string)
	for _, provider := range providerNames {
		rawEntry := obj[provider]
		if rawEntry == nil {
			continue
		}
		entry, ok := rawEntry.(map[string]any)
		if !ok {
			return nil, fmt.Errorf("failed to parse credentials file %q: provider %q must be an object", path, provider)
		}

		typeValue, exists, err := getStringPath(entry, "type")
		if err != nil {
			return nil, fmt.Errorf("failed to parse credentials file %q: %w", path, err)
		}
		if !exists || typeValue == "" {
			continue
		}

		canonical := canonicalProvider(provider)
		if canonical == "" {
			continue
		}

		typeValue = strings.ToLower(typeValue)
		switch typeValue {
		case "api":
			key, exists, err := getStringPath(entry, "key")
			if err != nil {
				return nil, fmt.Errorf("failed to parse credentials file %q: %w", path, err)
			}
			if !exists || key == "" {
				continue
			}
			if _, alreadySet := result[canonical]; !alreadySet {
				result[canonical] = key
			}
		case "oauth":
			if !includeOAuth {
				continue
			}
			accessToken, exists, err := getStringPath(entry, "access")
			if err != nil {
				return nil, fmt.Errorf("failed to parse credentials file %q: %w", path, err)
			}
			if !exists || accessToken == "" {
				continue
			}

			if rawExpiry, hasExpiry := entry["expires"]; hasExpiry {
				if rawExpiry == nil {
					// Null expiry is treated as missing (no expiry enforcement).
					if _, alreadySet := result[canonical]; !alreadySet {
						result[canonical] = accessToken
					}
					continue
				}
				expiresMillis, err := parseEpochMillis(rawExpiry)
				if err != nil {
					return nil, fmt.Errorf("failed to parse credentials file %q: invalid expires for provider %q: %w", path, provider, err)
				}
				expiresTime := time.UnixMilli(expiresMillis)
				if !expiresTime.After(now) {
					continue
				}
			}

			if _, alreadySet := result[canonical]; !alreadySet {
				result[canonical] = accessToken
			}
		default:
			continue
		}
	}

	if len(result) == 0 {
		return nil, nil
	}
	return result, nil
}

func parseAmp(homeDir string, _ bool, _ time.Time, _ basedir.Paths) (map[string]string, error) {
	path := filepath.Join(homeDir, ".amp", "config.json")
	obj, found, err := readJSONObjectIfExists(path)
	if err != nil {
		return nil, err
	}
	if !found {
		return nil, nil
	}

	fields := []string{
		"anthropicApiKey",
		"anthropic_api_key",
		"apiKey",
		"api_key",
		"accessToken",
		"access_token",
		"token",
		"auth.anthropicApiKey",
		"auth.apiKey",
		"auth.token",
		"anthropic.apiKey",
		"anthropic.token",
	}

	for _, field := range fields {
		value, exists, err := getStringPath(obj, field)
		if err != nil {
			return nil, fmt.Errorf("failed to parse credentials file %q: %w", path, err)
		}
		if exists && value != "" {
			return map[string]string{"anthropic": value}, nil
		}
	}

	return nil, nil
}

func parseAmikaEnvCache(_ string, _ bool, _ time.Time, paths basedir.Paths) (map[string]string, error) {
	path, err := paths.AuthEnvCacheFile()
	if err != nil {
		return nil, err
	}
	return parseAmikaCredentialFile(path)
}

func parseAmikaKeychain(_ string, _ bool, _ time.Time, paths basedir.Paths) (map[string]string, error) {
	path, err := paths.AuthKeychainFile()
	if err != nil {
		return nil, err
	}
	return parseAmikaCredentialFile(path)
}

func parseAmikaOAuth(_ string, includeOAuth bool, _ time.Time, paths basedir.Paths) (map[string]string, error) {
	if !includeOAuth {
		return nil, nil
	}
	path, err := paths.AuthOAuthFile()
	if err != nil {
		return nil, err
	}
	return parseAmikaCredentialFile(path)
}

var envStyleAPIKeyPattern = regexp.MustCompile(`(?i)^([A-Z0-9_-]+)_API_KEY$`)

func parseAmikaCredentialFile(path string) (map[string]string, error) {
	obj, found, err := readJSONObjectIfExists(path)
	if err != nil {
		return nil, err
	}
	if !found {
		return nil, nil
	}

	keys := make([]string, 0, len(obj))
	for k := range obj {
		keys = append(keys, k)
	}
	sort.Strings(keys)

	result := make(map[string]string)
	for _, key := range keys {
		raw := obj[key]
		value, ok := raw.(string)
		if !ok {
			continue
		}
		value = strings.TrimSpace(value)
		if value == "" {
			continue
		}

		keyUpper := strings.ToUpper(strings.TrimSpace(key))
		switch keyUpper {
		case "ANTHROPIC_API_KEY", "CLAUDE_API_KEY":
			if _, exists := result["anthropic"]; !exists {
				result["anthropic"] = value
			}
		case "OPENAI_API_KEY", "CODEX_API_KEY":
			if _, exists := result["openai"]; !exists {
				result["openai"] = value
			}
		default:
			match := envStyleAPIKeyPattern.FindStringSubmatch(keyUpper)
			if len(match) != 2 {
				continue
			}
			provider := canonicalProvider(strings.ToLower(match[1]))
			if provider == "" {
				continue
			}
			if _, exists := result[provider]; !exists {
				result[provider] = value
			}
		}
	}

	if len(result) == 0 {
		return nil, nil
	}
	return result, nil
}

func readJSONObjectIfExists(path string) (map[string]any, bool, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, false, nil
		}
		return nil, false, fmt.Errorf("failed to read credentials file %q: %w", path, err)
	}

	var payload any
	if err := json.Unmarshal(data, &payload); err != nil {
		return nil, false, fmt.Errorf("failed to parse credentials file %q: %w", path, err)
	}

	obj, ok := payload.(map[string]any)
	if !ok {
		return nil, false, fmt.Errorf("failed to parse credentials file %q: expected JSON object", path)
	}

	return obj, true, nil
}

func getStringPath(obj map[string]any, path string) (string, bool, error) {
	parts := strings.Split(path, ".")
	var current any = obj

	for i, part := range parts {
		if current == nil {
			return "", false, nil
		}
		m, ok := current.(map[string]any)
		if !ok {
			return "", false, fmt.Errorf("path %q expects an object at %q", path, strings.Join(parts[:i], "."))
		}

		raw, exists := m[part]
		if !exists {
			return "", false, nil
		}

		if i == len(parts)-1 {
			if raw == nil {
				return "", false, nil
			}
			s, ok := raw.(string)
			if !ok {
				return "", false, fmt.Errorf("path %q must be a string", path)
			}
			return strings.TrimSpace(s), true, nil
		}

		current = raw
	}

	return "", false, nil
}

func parseEpochMillis(raw any) (int64, error) {
	switch v := raw.(type) {
	case float64:
		if math.Trunc(v) != v {
			return 0, fmt.Errorf("must be an integer epoch millis")
		}
		return int64(v), nil
	case int64:
		return v, nil
	case int:
		return int64(v), nil
	case json.Number:
		i, err := strconv.ParseInt(string(v), 10, 64)
		if err != nil {
			return 0, fmt.Errorf("must be an integer epoch millis")
		}
		return i, nil
	default:
		return 0, fmt.Errorf("must be numeric epoch millis")
	}
}

// ClaudeCredential represents a single discovered Claude credential with its
// type and source preserved, suitable for interactive selection.
type ClaudeCredential struct {
	// Type is a human-readable label: "API Key" or "OAuth".
	Type string
	// Source describes where the credential was found (e.g. file path or "macOS Keychain").
	Source string
	// Value is the raw credential data to upload: the API key string or the full OAuth JSON.
	Value string
}

// DiscoverClaudeCredentials scans local credential sources and returns all
// Claude-specific credentials found, preserving their type and source. If
// homeDir is empty, the user's home directory is obtained from the operating
// system (e.g. the HOME environment variable or OS-level user database).
func DiscoverClaudeCredentials(homeDir string) ([]ClaudeCredential, error) {
	if homeDir == "" {
		var err error
		homeDir, err = os.UserHomeDir()
		if err != nil {
			return nil, fmt.Errorf("failed to get home directory: %w", err)
		}
	}

	var creds []ClaudeCredential

	// Check for API keys in Claude config files.
	apiKeyPaths := make([]string, len(ClaudeAPIKeyPaths()))
	for i, p := range ClaudeAPIKeyPaths() {
		apiKeyPaths[i] = filepath.Join(homeDir, p)
	}
	apiKeyFields := []string{"primaryApiKey", "apiKey", "anthropicApiKey", "customApiKey"}

	for _, path := range apiKeyPaths {
		obj, found, err := readJSONObjectIfExists(path)
		if err != nil || !found {
			continue
		}
		for _, field := range apiKeyFields {
			value, exists, err := getStringPath(obj, field)
			if err != nil || !exists || value == "" {
				continue
			}
			if strings.HasPrefix(value, "sk-ant-") {
				creds = append(creds, ClaudeCredential{
					Type:   "API Key",
					Source: path,
					Value:  value,
				})
				break // one API key per file is enough
			}
		}
	}

	// Check for OAuth credentials in files.
	oauthPaths := make([]string, len(ClaudeOAuthPaths()))
	for i, p := range ClaudeOAuthPaths() {
		oauthPaths[i] = filepath.Join(homeDir, p)
	}
	for _, path := range oauthPaths {
		data, err := os.ReadFile(path)
		if err != nil {
			continue
		}
		raw := strings.TrimSpace(string(data))
		// Verify it has claudeAiOauth.accessToken.
		obj, found, err := readJSONObjectIfExists(path)
		if err != nil || !found {
			continue
		}
		token, exists, _ := getStringPath(obj, "claudeAiOauth.accessToken")
		if !exists || token == "" {
			continue
		}
		creds = append(creds, ClaudeCredential{
			Type:   "OAuth",
			Source: path,
			Value:  raw,
		})
	}

	return creds, nil
}

// CodexCredential represents a single discovered Codex credential with its
// type and source preserved, suitable for interactive selection.
type CodexCredential struct {
	// Type is a human-readable label: "API Key" or "OAuth".
	Type string
	// Source describes where the credential was found (e.g. file path).
	Source string
	// Value is the raw credential data to upload: the API key string or the
	// full auth.json contents for OAuth.
	Value string
}

// DiscoverCodexCredentials scans local credential sources and returns all
// Codex-specific credentials found, preserving their type and source. If
// homeDir is empty, the user's home directory is obtained from the operating
// system (e.g. the HOME environment variable or OS-level user database).
func DiscoverCodexCredentials(homeDir string) ([]CodexCredential, error) {
	if homeDir == "" {
		var err error
		homeDir, err = os.UserHomeDir()
		if err != nil {
			return nil, fmt.Errorf("failed to get home directory: %w", err)
		}
	}

	var creds []CodexCredential

	for _, rel := range CodexCredentialPaths() {
		path := filepath.Join(homeDir, rel)
		data, err := os.ReadFile(path)
		if err != nil {
			continue
		}
		raw := strings.TrimSpace(string(data))

		obj, found, err := readJSONObjectIfExists(path)
		if err != nil || !found {
			continue
		}

		// API key takes precedence when present and non-empty.
		apiKey, exists, err := getStringPath(obj, "OPENAI_API_KEY")
		if err == nil && exists && apiKey != "" {
			creds = append(creds, CodexCredential{
				Type:   "API Key",
				Source: path,
				Value:  apiKey,
			})
		}

		// OAuth credentials are identified by tokens.access_token; the value
		// uploaded is the entire auth.json file so refresh tokens are preserved.
		token, exists, err := getStringPath(obj, "tokens.access_token")
		if err == nil && exists && token != "" {
			creds = append(creds, CodexCredential{
				Type:   "OAuth",
				Source: path,
				Value:  raw,
			})
		}
	}

	return creds, nil
}

// ClaudeAPIKeyPaths returns the home-relative paths where Claude Code stores
// API key configuration. Callers should join each with a home directory.
func ClaudeAPIKeyPaths() []string {
	return []string{
		".claude.json.api",
		".claude.json",
	}
}

// ClaudeOAuthPaths returns the home-relative paths where Claude Code stores
// OAuth credentials. Callers should join each with a home directory.
func ClaudeOAuthPaths() []string {
	return []string{
		filepath.Join(".claude", ".credentials.json"),
		".claude-oauth-credentials.json",
	}
}

// ClaudeCredentialPaths returns the home-relative paths where Claude Code
// stores credentials. Callers should join each with a home directory.
func ClaudeCredentialPaths() []string {
	return append(ClaudeAPIKeyPaths(), ClaudeOAuthPaths()...)
}

// CodexCredentialPaths returns the home-relative paths where Codex stores
// credentials. Callers should join each with a home directory.
func CodexCredentialPaths() []string {
	return []string{
		filepath.Join(".codex", "auth.json"),
	}
}

// OpenCodeCredentialPaths returns the home-relative paths where OpenCode
// stores credentials. Callers should join each with a home directory.
func OpenCodeCredentialPaths() []string {
	return []string{
		filepath.Join(".local", "share", "opencode", "auth.json"),
	}
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

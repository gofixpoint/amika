package sandbox

import (
	"fmt"
	"strings"
)

// AllowedGithubAuthModes lists the GitHub auth mode names available for user
// selection via --github-auth-mode.
var AllowedGithubAuthModes = []string{"pat", "app_token", "app-token"}

// canonicalGithubAuthModeAliases maps accepted aliases to the canonical value
// sent to the remote API.
var canonicalGithubAuthModeAliases = map[string]string{
	"app-token": "app_token",
}

// CanonicalGithubAuthMode converts accepted aliases to the canonical value
// expected by the API. Unknown values are returned unchanged.
func CanonicalGithubAuthMode(mode string) string {
	if canonical, ok := canonicalGithubAuthModeAliases[mode]; ok {
		return canonical
	}
	return mode
}

// ValidateGithubAuthMode returns an error if mode is non-empty and not in
// AllowedGithubAuthModes. An empty string is accepted (server default).
func ValidateGithubAuthMode(mode string) error {
	mode = CanonicalGithubAuthMode(mode)
	if mode == "" {
		return nil
	}
	for _, m := range AllowedGithubAuthModes {
		if mode == CanonicalGithubAuthMode(m) {
			return nil
		}
	}
	return fmt.Errorf("unknown github-auth-mode %q; allowed modes: %s", mode, strings.Join(AllowedGithubAuthModes, ", "))
}

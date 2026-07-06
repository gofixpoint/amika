package sandbox

import (
	"fmt"
	"strings"
)

// AllowedGithubAuthModes lists the GitHub auth mode names available for user
// selection via --github-auth-mode.
var AllowedGithubAuthModes = []string{"pat", "app_token"}

// ValidateGithubAuthMode returns an error if mode is non-empty and not in
// AllowedGithubAuthModes. An empty string is accepted (server default).
func ValidateGithubAuthMode(mode string) error {
	if mode == "" {
		return nil
	}
	for _, m := range AllowedGithubAuthModes {
		if mode == m {
			return nil
		}
	}
	return fmt.Errorf("unknown github-auth-mode %q; allowed modes: %s", mode, strings.Join(AllowedGithubAuthModes, ", "))
}

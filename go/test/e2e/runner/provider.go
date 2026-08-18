package runner

import "fmt"

var supportedSandboxProviders = map[string]struct{}{
	"daytona":   {},
	"freestyle": {},
	"sailbox":   {},
	"vercel":    {},
}

// ValidateSandboxProvider rejects providers the remote E2E suite cannot select.
func ValidateSandboxProvider(provider string) error {
	if _, ok := supportedSandboxProviders[provider]; !ok {
		return fmt.Errorf("unsupported sandbox provider %q (want daytona, freestyle, sailbox, or vercel)", provider)
	}
	return nil
}

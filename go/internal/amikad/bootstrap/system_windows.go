//go:build windows

package bootstrap

import "errors"

// Owner is not available on Windows, where amikad does not bootstrap rigs.
func (OSSystem) Owner(string) (int, int, error) {
	return 0, 0, errors.New("file owners are not supported on Windows")
}

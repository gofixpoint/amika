// Package arch provides platform detection helpers.
package arch

import "runtime"

// IsMacOS reports whether the current operating system is macOS.
func IsMacOS() bool {
	return runtime.GOOS == "darwin"
}

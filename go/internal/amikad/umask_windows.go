//go:build windows

package amikad

// useStandardUmask does nothing on Windows, which has no umask.
func useStandardUmask() {}

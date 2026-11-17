//go:build !windows

package amikad

import "syscall"

// useStandardUmask makes files amikad creates as root readable by the amika
// user, whatever umask a hardened image sets (027 would leave the tools
// unreadable). npm and the package manager inherit it.
func useStandardUmask() {
	syscall.Umask(0o022)
}

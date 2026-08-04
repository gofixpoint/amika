//go:build aix || darwin || dragonfly || freebsd || linux || netbsd || openbsd || solaris

package filelock

import (
	"errors"
	"os"
	"syscall"
)

func tryLock(file *os.File) (bool, error) {
	err := syscall.Flock(int(file.Fd()), syscall.LOCK_EX|syscall.LOCK_NB)
	if errors.Is(err, syscall.EWOULDBLOCK) || errors.Is(err, syscall.EAGAIN) {
		return false, nil
	}
	return err == nil, err
}

func unlock(file *os.File) error {
	return syscall.Flock(int(file.Fd()), syscall.LOCK_UN)
}

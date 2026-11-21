//go:build !windows

package bootstrap

import (
	"fmt"
	"os"
	"syscall"
)

// Owner reads a path's owner from its inode.
func (OSSystem) Owner(path string) (int, int, error) {
	info, err := os.Stat(path)
	if err != nil {
		return 0, 0, err
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return 0, 0, fmt.Errorf("%s has no owner", path)
	}
	return int(stat.Uid), int(stat.Gid), nil
}

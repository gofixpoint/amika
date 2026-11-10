//go:build aix || darwin || dragonfly || freebsd || linux || netbsd || openbsd || solaris

package sandboxcmd

import (
	"fmt"
	"os"
	"syscall"
)

func checkAgentDirectoryOwner(dir string, info os.FileInfo) error {
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || uint64(stat.Uid) != uint64(os.Geteuid()) {
		return fmt.Errorf("amika-net directory %s must belong to the current user", dir)
	}
	return nil
}

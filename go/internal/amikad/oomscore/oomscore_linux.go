//go:build linux

package oomscore

import (
	"fmt"
	"log/slog"
	"os"
	"strconv"
)

// selfScoreAdjPath resolves per process, so the same path serves amikad and
// the shell that wraps each of its children.
const selfScoreAdjPath = "/proc/self/oom_score_adj"

// resetScript resets the shell's own value, then replaces the shell with the
// command held in its positional parameters. Because exec keeps the pid and
// the value, the command never runs at amikad's value, and its arguments
// reach it untouched. A failed write is reported on stderr under
// resetScriptName but does not stop the command: it fails only where the
// inherited value is pinned above ChildScoreAdj, which also means amikad
// could not lower its own, so there is no protection to pass on.
var resetScript = fmt.Sprintf(`echo %d > %s; exec "$@"`, ChildScoreAdj, selfScoreAdjPath)

// resetScriptName is the shell's $0, which names it in its error messages.
const resetScriptName = "amikad-oom-reset"

// ProtectSelf sets the calling process's oom_score_adj to DaemonScoreAdj.
// Lowering the value needs CAP_SYS_RESOURCE, so a failure is logged as a
// warning and the process carries on with the value it inherited.
func ProtectSelf(logger *slog.Logger) {
	protect(selfScoreAdjPath, logger)
}

// Command returns the program and arguments that run name with args at
// ChildScoreAdj, for passing to exec.Command.
func Command(name string, args ...string) (string, []string) {
	return "/bin/sh", append([]string{"-c", resetScript, resetScriptName, name}, args...)
}

func protect(path string, logger *slog.Logger) {
	if err := writeScoreAdj(path, DaemonScoreAdj); err != nil {
		logger.Warn("could not lower OOM score; continuing with the inherited value",
			"path", path, "oom_score_adj", DaemonScoreAdj, "error", err)
	}
}

func writeScoreAdj(path string, value int) error {
	// No O_CREATE: the file is procfs's to provide, never ours to make.
	file, err := os.OpenFile(path, os.O_WRONLY, 0)
	if err != nil {
		return err
	}
	_, err = file.WriteString(strconv.Itoa(value))
	if closeErr := file.Close(); err == nil {
		err = closeErr
	}
	return err
}

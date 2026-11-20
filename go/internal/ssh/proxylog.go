package ssh

import (
	"io"
	"log/slog"
	"os"
	"path/filepath"

	"github.com/gofixpoint/amika/go/internal/basedir"
)

// proxyLogName is the stdio proxy's event log in the amika state directory.
// Each line is one JSON event: the session's ref, never its secret.
const proxyLogName = "ssh-proxy.log"

// proxyLogMaxBytes is the size at which the log moves to proxyLogName.1 and
// starts again, so it keeps the recent sessions and stays small.
const proxyLogMaxBytes = 1 << 20

// OpenProxyEventLog returns a logger that appends the stdio proxy's session
// events to the state directory, and a function that closes it. Logging is
// best effort: on any error the logger discards, and the proxy runs anyway.
func OpenProxyEventLog(paths basedir.Paths) (*slog.Logger, func()) {
	discard := slog.New(slog.DiscardHandler)
	stateDir, err := paths.AmikaStateDir()
	if err != nil {
		return discard, func() {}
	}
	if err := os.MkdirAll(stateDir, 0o700); err != nil {
		return discard, func() {}
	}
	path := filepath.Join(stateDir, proxyLogName)
	if info, err := os.Lstat(path); err == nil && info.Mode().IsRegular() && info.Size() > proxyLogMaxBytes {
		_ = os.Rename(path, path+".1")
	}
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_APPEND|os.O_CREATE, 0o600)
	if err != nil {
		return discard, func() {}
	}
	return slog.New(slog.NewJSONHandler(io.Writer(file), nil)).With(slog.Int("pid", os.Getpid())), func() { _ = file.Close() }
}

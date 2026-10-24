//go:build !linux

package oomscore

import "log/slog"

// ProtectSelf does nothing: oom_score_adj exists only on Linux.
func ProtectSelf(*slog.Logger) {}

// Command returns name and args unchanged: there is no inherited
// oom_score_adj to reset outside Linux.
func Command(name string, args ...string) (string, []string) {
	return name, args
}

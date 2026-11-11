#!/bin/sh
# Compiles xterm-ghostty.src into xterm-ghostty, the entry amikad embeds.
# Run it on macOS: its /usr/bin/tic writes the legacy format that every
# ncurses reads. With --check, it compares instead of writing.
set -eu
cd "$(dirname "$0")"
out=$(mktemp -d)
trap 'rm -rf "$out"' EXIT
TERMINFO="$out" /usr/bin/tic -x xterm-ghostty.src
compiled=$(find "$out" -type f -name xterm-ghostty)
if [ "${1:-}" = "--check" ]; then
	if ! cmp -s "$compiled" xterm-ghostty; then
		echo "xterm-ghostty does not match xterm-ghostty.src. Run $0 on macOS." >&2
		exit 1
	fi
else
	cp "$compiled" xterm-ghostty
fi

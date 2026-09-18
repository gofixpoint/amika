#!/bin/sh
# Greets an interactive SSH login with what a new arrival needs: which rig they
# landed on, and where the CLI, agent, and web docs are.
#
# Run rather than sourced by the runtime dotfiles. A sourced script's `exit`
# would close the login shell, and everything read below is exported, so a
# child process sees the same values the shell does.

set -eu

# Only a person at a terminal should see this. Being run from .bashrc and
# .zshrc already excludes non-interactive shells, so `amika sandbox ssh <name>
# <command>` and scp never reach here. What remains to exclude is output that
# is not a terminal, sessions that did not arrive over SSH, and the extra
# shells tmux spawns once a session is already underway.
[ -t 1 ] || exit 0
[ -n "${SSH_CONNECTION:-}" ] || exit 0
[ -z "${TMUX:-}" ] || exit 0

printf '\n'

cat <<'EOF'
╭──────────────────────╮
│ ╭──────────────────╮ │
│ │   ███▀    ███▀   │ │
│ │   ███▄    ███▄   │ │
│ │                  │ │
│ │                  │ │
│ ╰──────────────────╯ │
╰──────────────────────╯
  ╰──────────────────╯

             ▀ █
▄▀▀█ █▀▀█▀▀█ █ █  ▄ ▄▀▀█
█  █ █  █  █ █ █▄▀  █  █
▀▄▄█ █  █  █ █ █ ▀▄ ▀▄▄█

EOF

# AMIKA_SANDBOX_NAME carries the rig's own name into every session of a hosted
# sandbox. A rig booted without it is still greeted, just without a name: the
# hostname is a provider-assigned container id, so naming it would mislead
# rather than orient.
if [ -n "${AMIKA_SANDBOX_NAME:-}" ]; then
  printf 'You'\''re on the Amika rig "%s".\n' "$AMIKA_SANDBOX_NAME"
else
  printf 'You'\''re on an Amika rig.\n'
fi

cat <<'EOF'

Type amika help for CLI help.

Run cat ~/.agents/skills/amika-cli/SKILL.md to see how an agent can use Amika.

Go to https://docs.amika.dev/ for more docs. Happy hacking.

EOF

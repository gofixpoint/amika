#!/bin/bash
# Installs shell and terminal dotfiles for current and future runtime users.

set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "usage: $0 <stable-assets-directory>" >&2
  exit 64
fi

runtime_user="${AMIKA_RUNTIME_USER:-amika}"
runtime_group="${AMIKA_RUNTIME_GROUP:-$runtime_user}"
runtime_home="${AMIKA_RUNTIME_HOME:-/home/$runtime_user}"

for dotfile in .bashrc .tmux.conf .zshrc; do
  install -m 0644 "$1/$dotfile" "/etc/skel/$dotfile"
  install -m 0644 -o "$runtime_user" -g "$runtime_group" \
    "$1/$dotfile" "$runtime_home/$dotfile"
done

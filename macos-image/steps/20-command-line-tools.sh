#!/bin/bash
# Installs the Xcode Command Line Tools: git, clang, make, and python3.

set -euo pipefail

if xcode-select -p >/dev/null 2>&1; then
  exit 0
fi
# softwareupdate lists the tools only while this file exists.
marker=/tmp/.com.apple.dt.CommandLineTools.installondemand.in-progress
touch "$marker"
label="$(softwareupdate --list 2>/dev/null |
  sed -n 's/^\* Label: \(Command Line Tools for Xcode.*\)$/\1/p' |
  sort -V | tail -n 1)"
if [[ -z "$label" ]]; then
  echo "softwareupdate lists no Command Line Tools" >&2
  exit 1
fi
softwareupdate --install "$label" --agree-to-license
rm -f "$marker"
xcode-select -p

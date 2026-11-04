#!/bin/bash
# Fails the build when the image does not have what rigs need.

set -euo pipefail

eval "$(/usr/libexec/path_helper -s)"
failed=0
check() {
  local what="$1"
  shift
  if "$@" >/dev/null 2>&1; then
    echo "ok   $what"
  else
    echo "FAIL $what" >&2
    failed=1
  fi
}

check "amika user" id amika
check "amika sudo" sudo -u amika sudo -n true
check "amika SSH group" dseditgroup -o checkmember -m amika com.apple.access_ssh
check "command line tools" xcode-select -p
check "git" git --version
check "python3" python3 --version
check "Node $NODE_VERSION" sh -c "node --version | grep -qx v$NODE_VERSION"
check "npm $NPM_VERSION" sh -c "npm --version | grep -qx $NPM_VERSION"
check "bash 5" sh -c "/opt/homebrew/bin/bash --version | grep -q 'version 5'"
check "GNU coreutils" /opt/homebrew/opt/coreutils/libexec/gnubin/ls --version
check "GNU sed" /opt/homebrew/opt/gnu-sed/libexec/gnubin/sed --version
check "GNU findutils" /opt/homebrew/opt/findutils/libexec/gnubin/find --version
check "jq" jq --version
check "claude $CLAUDE_CODE_VERSION" sh -c "claude --version | grep -q $CLAUDE_CODE_VERSION"
check "codex $CODEX_VERSION" sh -c "codex --version | grep -q $CODEX_VERSION"
check "opencode" opencode --version
check "amikad" amikad --version
check "amikad launchd job" plutil -lint /usr/local/lib/amikad/com.amika.amikad.plist
check "lifecycle hooks" test -x /usr/local/lib/amikad/run-hook.sh -a -x /usr/local/lib/amikad/pre-setup.sh
# The image must not carry credentials or start the SSH bridge.
check "amikad not loaded" sh -c '! launchctl print system/com.amika.amikad'
check "no amikad state" test -z "$(ls -A /private/var/lib/amikad)"
check "no amika SSH keys" test ! -e /Users/amika/.ssh/authorized_keys

exit "$failed"

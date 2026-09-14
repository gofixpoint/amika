#!/bin/bash
# Verifies the SSH login greeting is installed, wired into both shell rc files,
# and actually reached by a login shell of each.
# shellcheck disable=SC1091,SC2034
CHECK_ID="login-welcome"
CHECK_CONTEXTS="build"
source "$(dirname "$0")/../lib/check.sh" "$@"

welcome="$(manifest_value image.welcome_script)"
home="$(runtime_home)"
problems=()
[[ -x "$welcome" ]] || problems+=("$welcome=not-executable")
# Named rather than read from image.dotfiles: .tmux.conf is a dotfile too, and
# only the two shell rc files are expected to run anything at login.
for rc in .bashrc .zshrc; do
  grep -qF "$welcome" "$home/$rc" 2>/dev/null || problems+=("$rc=no-reference")
done

# Wired is not the same as reached. Bash reads .bashrc for an interactive
# non-login shell, but for a login shell it reads the first of .bash_profile,
# .bash_login, .profile instead -- so the rc reference above is only live
# because the base image's stock .profile sources .bashrc. This image neither
# installs nor owns that file, and a shadowing .bash_profile or a base-image
# change would break the chain silently. Drive a real login shell instead of
# trusting it: `script` supplies the terminal welcome.sh insists on, and
# SSH_CONNECTION stands in for the session it checks for.
#
# The marker comes out of the script rather than being a copy of its wording,
# so rephrasing the greeting does not fail this check.
marker="$(grep -om1 'https://docs\.amika\.dev[^ ]*' "$welcome" 2>/dev/null || true)"
if [[ -z "$marker" ]]; then
  problems+=("$welcome=no-marker-to-match")
elif ! command -v script >/dev/null 2>&1; then
  # Report the missing tool rather than letting it read as a broken chain.
  problems+=("script=missing-cannot-drive-a-login-shell")
else
  for shell in bash zsh; do
    greeting="$(run_as_runtime_user env SSH_CONNECTION=verify \
      script -qec "$shell -lic true" /dev/null 2>/dev/null || true)"
    grep -qF "$marker" <<<"$greeting" || problems+=("$shell-login=greeting-not-reached")
  done
fi

[[ ${#problems[@]} -eq 0 ]] && pass "login greeting installed, wired, and reached by a login shell" "welcome script wired and reached"
fail "login greeting installed, wired, and reached by a login shell" "${problems[*]}"

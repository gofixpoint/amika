#!/bin/bash
# Adds the `amika` user, as on Linux images: home /Users/amika, `sudo` with
# no password, and SSH login allowed.

set -euo pipefail

if ! dscl . -read /Users/amika >/dev/null 2>&1; then
  uid=$(dscl . -list /Users UniqueID |
    awk '$2 > max { max = $2 } END { print (max >= 501 ? max + 1 : 501) }')
  dscl . -create /Users/amika
  dscl . -create /Users/amika UserShell /bin/zsh
  dscl . -create /Users/amika RealName Amika
  dscl . -create /Users/amika UniqueID "$uid"
  dscl . -create /Users/amika PrimaryGroupID 20
  dscl . -create /Users/amika NFSHomeDirectory /Users/amika
  dscl . -passwd /Users/amika "$(openssl rand -hex 24)"
  createhomedir -c -u amika >/dev/null
fi
# Remote Login admits only this group.
dseditgroup -o edit -a amika -t user com.apple.access_ssh

printf '%s\n' 'amika ALL=(ALL) NOPASSWD: ALL' >/etc/sudoers.d/amika
chmod 440 /etc/sudoers.d/amika
visudo -cf /etc/sudoers.d/amika >/dev/null

install -d -m 700 -o amika -g staff /Users/amika/.ssh
install -d -m 755 -o amika -g staff /Users/amika/workspace

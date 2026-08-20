#!/bin/bash
# Creates and configures the unprivileged runtime user and its system paths.

set -euo pipefail

runtime_user="${AMIKA_RUNTIME_USER:-amika}"
runtime_group="${AMIKA_RUNTIME_GROUP:-$runtime_user}"
runtime_home="${AMIKA_RUNTIME_HOME:-/home/$runtime_user}"

if ! getent group "$runtime_group" >/dev/null; then
  groupadd "$runtime_group"
fi
if ! id "$runtime_user" >/dev/null 2>&1; then
  useradd -m -d "$runtime_home" -s /usr/bin/zsh -g "$runtime_group" \
    "$runtime_user"
fi

usermod -s /usr/bin/zsh "$runtime_user"
# shellcheck disable=SC2016  # keep the crypt hash literal
usermod --password \
  '$6$pdjtCb0QP/guq5xn$iwYNhGlawvdfJqqAeGINjgtq.2yFgcFCvRItN.ly3astbptigtMioqI/opqrgmEdHdDQ.sg0/LOWW5vyp9tHz0' \
  "$runtime_user"
usermod -aG sudo "$runtime_user"

cat > "/etc/sudoers.d/90-${runtime_user}" <<EOF
${runtime_user} ALL=(ALL) NOPASSWD:ALL
EOF
chmod 0440 "/etc/sudoers.d/90-${runtime_user}"

install -d -m 0700 -o "$runtime_user" -g "$runtime_group" \
  "$runtime_home/.ssh"
# The /run and /tmp counterparts of these directories are not created here.
# Both filesystems are wiped on every boot, so an image cannot carry them;
# pre-setup.sh creates them at boot instead.
install -d -m 0755 -o "$runtime_user" -g "$runtime_group" \
  "$runtime_home/workspace" \
  /var/log/amika \
  /usr/lib/amika \
  /usr/local/etc/amika \
  /var/lib/amika
install -d -m 0755 \
  /var/log/amikad \
  /usr/lib/amikad \
  /usr/local/etc/amikad/setup \
  /var/lib/amikad

cat > /usr/local/etc/amikad/setup/setup.sh <<'EOF'
#!/bin/bash
exit 0
EOF
cat > /usr/local/etc/amikad/setup/start.sh <<'EOF'
#!/bin/bash
exit 0
EOF
chmod 0755 \
  /usr/local/etc/amikad/setup/setup.sh \
  /usr/local/etc/amikad/setup/start.sh

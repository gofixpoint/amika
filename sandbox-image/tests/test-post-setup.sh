#!/bin/bash
# Runs assets/hooks/post-setup.sh against a fake amika home that holds a
# dangling symlink, as pnpm 11 leaves in its store. The hook must exit 0
# and keep the symlink.
#
# Shims stand in for getent (to point the amika home at a temp directory)
# and sudo (to chown to the current user, so the test needs no root and no
# amika account). The real chown runs, because its symlink handling is what
# the test checks. Only GNU chown matches the image, so other chowns skip.

set -euo pipefail

bundle_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
hook="$bundle_dir/assets/hooks/post-setup.sh"

if ! chown --version 2>/dev/null | grep -q 'GNU coreutils'; then
  echo "test-post-setup: skipped (needs GNU chown, as in the image)"
  exit 0
fi

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

shims="$work/shims"
mkdir -p "$shims"

cat > "$shims/getent" <<EOF
#!/bin/bash
[[ "\$1 \$2" == "passwd amika" ]] || exit 2
echo "amika:x:1000:1000::$work/home-link:/bin/bash"
EOF

cat > "$shims/sudo" <<'EOF'
#!/bin/bash
args=()
for arg in "$@"; do
  [[ "$arg" == "amika:amika" ]] && arg="$(id -u):$(id -g)"
  args+=("$arg")
done
exec "${args[@]}"
EOF
chmod +x "$shims/getent" "$shims/sudo"

# The home is a symlink to the real directory, which -H must follow.
home="$work/home"
mkdir -p "$home/.local/share/pnpm/store"
ln -s "$home" "$work/home-link"
touch "$home/.local/share/pnpm/file"
ln -s "$work/missing" "$home/.local/share/pnpm/store/dangling"

if ! PATH="$shims:$PATH" bash "$hook"; then
  echo "test-post-setup: post-setup.sh failed on a home with a dangling symlink" >&2
  exit 1
fi

if [[ ! -L "$home/.local/share/pnpm/store/dangling" ]]; then
  echo "test-post-setup: post-setup.sh removed the dangling symlink" >&2
  exit 1
fi

echo "test-post-setup: passed"

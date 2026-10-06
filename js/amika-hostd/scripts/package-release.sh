#!/bin/sh
# Build the amika-hostd release tarball and its checksums.txt.
#
# Usage: scripts/package-release.sh VERSION [OUT_DIR]
#
# Writes OUT_DIR/amika-hostd_VERSION.tar.gz (default OUT_DIR: dist/release),
# holding amika-hostd_VERSION/:
#   amika-hostd.mjs                the bundled daemon
#   config.example.toml
#   node_modules/smolmachines/     the smolmachines SDK (smolvm's engine), the
#                                  one dependency the bundle leaves out
#   engines.sha256                 the SHA-256 of each platform's engine
#                                  package on npm, in `sha256sum` format
# plus OUT_DIR/checksums.txt in the `sha256sum` format install-amika-hostd.sh
# verifies. The engine itself (native addon, boot helper, hypervisor libraries
# and guest rootfs) is per platform and over 100 MB, so the tarball does not
# carry it: the installer downloads the one package its host needs from npm
# and checks it against engines.sha256. One tarball serves every platform.
set -eu

if [ "$#" -lt 1 ]; then
  echo "Usage: $0 VERSION [OUT_DIR]" >&2
  exit 1
fi

version="${1#v}"
package_dir="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "${2:-${package_dir}/dist/release}"
out_dir="$(cd "${2:-${package_dir}/dist/release}" && pwd)"
archive_base="amika-hostd_${version}"
staging_dir="${out_dir}/${archive_base}"
work_dir="$(mktemp -d)"
trap 'rm -rf "$work_dir"' EXIT

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$@"
  else
    shasum -a 256 "$@"
  fi
}

# The exact version package.json pins, so the release ships what was tested.
engine_version="$(node -p 'require(process.argv[1]).dependencies.smolmachines' "${package_dir}/package.json")"
case "$engine_version" in
  [0-9]*.[0-9]*.[0-9]*) ;;
  *)
    echo "Error: package.json must pin smolmachines to an exact version, not ${engine_version}" >&2
    exit 1
    ;;
esac
# The smolvm-sdk provider hostd runs on was built against @amika/sandbox's
# pin; ship the same engine.
sandbox_version="$(node -p 'require(process.argv[1]).dependencies.smolmachines' "${package_dir}/../sandbox/package.json")"
if [ "$sandbox_version" != "$engine_version" ]; then
  echo "Error: smolmachines is pinned to ${engine_version} in amika-hostd but ${sandbox_version} in @amika/sandbox; pin both to the same version" >&2
  exit 1
fi

rm -rf "$staging_dir"
mkdir -p "$staging_dir/node_modules/smolmachines"
node "${package_dir}/scripts/bundle.mjs" "${staging_dir}/amika-hostd.mjs"
cp "${package_dir}/config.example.toml" "${staging_dir}/"

# `npm pack` fetches a package's registry tarball and verifies its integrity.
(cd "$work_dir" && npm pack --silent "smolmachines@${engine_version}" >/dev/null)
tar -xzf "${work_dir}/smolmachines-${engine_version}.tgz" \
  -C "${staging_dir}/node_modules/smolmachines" --strip-components=1

# Every platform the SDK ships an engine for, at the version it pins.
platforms="$(node -p 'Object.entries(require(process.argv[1]).optionalDependencies).map(([name, v]) => `${name}@${v}`).join("\n")' \
  "${staging_dir}/node_modules/smolmachines/package.json")"
(
  cd "$work_dir"
  for platform in $platforms; do
    npm pack --silent "$platform" >/dev/null
  done
  sha256 smolmachines-*-*.tgz | grep -v " smolmachines-${engine_version}.tgz\$"
) > "${staging_dir}/engines.sha256"

tar -C "$out_dir" -czf "${out_dir}/${archive_base}.tar.gz" "$archive_base"
rm -rf "$staging_dir"

cd "$out_dir"
sha256 "${archive_base}.tar.gz" > checksums.txt
echo "Wrote ${out_dir}/${archive_base}.tar.gz and checksums.txt"

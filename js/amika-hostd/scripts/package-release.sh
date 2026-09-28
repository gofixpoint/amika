#!/bin/sh
# Build the amika-hostd release tarball and its checksums.txt.
#
# Usage: scripts/package-release.sh VERSION [OUT_DIR]
#
# Writes OUT_DIR/amika-hostd_VERSION.tar.gz (default OUT_DIR: dist/release),
# holding amika-hostd_VERSION/{amika-hostd.mjs,config.example.toml}, plus
# OUT_DIR/checksums.txt in the `sha256sum` format install-amika-hostd.sh verifies. The
# bundle is plain JavaScript, so one tarball serves every platform.
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

rm -rf "$staging_dir"
mkdir -p "$staging_dir"
node "${package_dir}/scripts/bundle.mjs" "${staging_dir}/amika-hostd.mjs"
cp "${package_dir}/config.example.toml" "${staging_dir}/"

tar -C "$out_dir" -czf "${out_dir}/${archive_base}.tar.gz" "$archive_base"
rm -rf "$staging_dir"

cd "$out_dir"
if command -v sha256sum >/dev/null 2>&1; then
  sha256sum "${archive_base}.tar.gz" > checksums.txt
else
  shasum -a 256 "${archive_base}.tar.gz" > checksums.txt
fi
echo "Wrote ${out_dir}/${archive_base}.tar.gz and checksums.txt"

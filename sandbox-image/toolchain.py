#!/usr/bin/env python3
"""Generate the toolchain lockfile from versions.env.

A rig that boots the provider's own image (Instabox, and any customer cloud
account) gets its dependencies from `amikad install`, which reads this
lockfile. It pins the amikad release the control plane uploads and every
dependency a rig can install, at the versions the base image builds from:

- gh is the one default; every other dependency is installed only when a
  caller asks for it (`amikad install --dep <name>`). A gh the image already
  has outside /usr/local/bin is kept (`prefer_image`).
- archive dependencies carry a URL and sha256 per platform. Each archive is
  downloaded here, its sha256 computed and checked against the publisher's
  checksum file where there is one, and its commands checked to exist.
- npm dependencies carry an exact version and the commands the package
  declares; npm checks the registry's integrity hashes at install, as in the
  image build. Pi and Pi Web install with --engine-strict and
  --ignore-scripts, as steps 80 and 82 install them.

Run it after changing versions.env:

    python3 sandbox-image/toolchain.py          # regenerate (downloads)
    python3 sandbox-image/toolchain.py --check  # versions match (no network)
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import sys
import tarfile
import urllib.request
from pathlib import Path

BUNDLE = Path(__file__).resolve().parent
REPO = BUNDLE.parent
VERSIONS = BUNDLE / "versions.env"
LOCKFILE = BUNDLE / "toolchain.lock.json"

PLATFORMS = {
    # lockfile platform -> names the publishers use
    "linux/amd64": {"node": "x64", "go": "amd64", "rust": "x86_64"},
    "linux/arm64": {"node": "arm64", "go": "arm64", "rust": "aarch64"},
}

AMIKA_RELEASES = "https://github.com/gofixpoint/amika/releases/download"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument(
        "--check",
        action="store_true",
        help="fail when the lockfile's versions differ from versions.env",
    )
    args = parser.parse_args()
    versions = read_versions(VERSIONS)
    if args.check:
        return check(versions)
    lock = build(versions)
    LOCKFILE.parent.mkdir(parents=True, exist_ok=True)
    LOCKFILE.write_text(json.dumps(lock, indent=2) + "\n")
    print(f"wrote {LOCKFILE.relative_to(REPO)}")
    return 0


def read_versions(path: Path) -> dict[str, str]:
    versions = {}
    for line in path.read_text().splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            key, value = line.split("=", 1)
            versions[key] = value
    return versions


def dep_versions(versions: dict[str, str]) -> dict[str, str]:
    """The version each lockfile entry must have."""
    return {
        "amikad": versions["AMIKAD_VERSION"],
        "gh": versions["GH_VERSION"],
        "node": versions["NODE_VERSION"],
        "amika": versions["AMIKA_VERSION"],
        "codex": versions["CODEX_VERSION"],
        "pnpm": versions["PNPM_VERSION"],
        "claude-code": versions["CLAUDE_CODE_VERSION"],
        "npm": versions["NPM_VERSION"],
        "opencode": versions["OPENCODE_VERSION"],
        "pi": versions["PI_VERSION"],
        "typescript": versions["TYPESCRIPT_VERSION"],
        "tsx": versions["TSX_VERSION"],
        "pi-web": versions["PI_WEB_VERSION"],
    }


def check(versions: dict[str, str]) -> int:
    if not LOCKFILE.exists():
        print(f"{LOCKFILE.relative_to(REPO)} is missing; run {Path(__file__).name}")
        return 1
    lock = json.loads(LOCKFILE.read_text())
    have = {dep["name"]: dep["version"] for dep in lock["deps"]}
    have["amikad"] = lock["amikad"]["version"]
    want = dep_versions(versions)
    if have != want:
        for name in sorted(set(have) | set(want)):
            if have.get(name) != want.get(name):
                print(f"{name}: lockfile {have.get(name)}, versions.env {want.get(name)}")
        print(f"run python3 sandbox-image/{Path(__file__).name} to refresh the lockfile")
        return 1
    return 0


def build(versions: dict[str, str]) -> dict:
    v = dep_versions(versions)
    deps = [
        # The default: the control plane's gh auth shim takes
        # /usr/local/bin/gh and runs the next gh on PATH, so gh links into
        # /usr/bin, and a gh the image has elsewhere on PATH is kept.
        {**gh(v["gh"]), "default": True, "link_dir": "/usr/bin", "prefer_image": True},
        node(v["node"]),
        amika_release("amika", v["amika"]),
        codex(v["codex"]),
        npm_dep("pnpm", "pnpm", v["pnpm"]),
        npm_dep("claude-code", "@anthropic-ai/claude-code", v["claude-code"]),
        npm_dep("npm", "npm", v["npm"]),
        npm_dep("opencode", "opencode-ai", v["opencode"]),
        npm_dep("pi", "@earendil-works/pi-coding-agent", v["pi"], strict=True),
        npm_dep("pi-web", "@agegr/pi-web", v["pi-web"], strict=True),
        npm_dep("typescript", "typescript", v["typescript"]),
        npm_dep("tsx", "tsx", v["tsx"]),
    ]
    return {"schema": 2, "amikad": amika_release("amikad", v["amikad"]), "deps": deps}


def node(version: str) -> dict:
    sums = published_sums(f"https://nodejs.org/dist/v{version}/SHASUMS256.txt")
    artifacts = {}
    for platform, names in PLATFORMS.items():
        name = f"node-v{version}-linux-{names['node']}.tar.gz"
        artifacts[platform] = archive(
            f"https://nodejs.org/dist/v{version}/{name}",
            strip=1,
            bins=[{"path": "bin/node"}, {"path": "bin/npm"}, {"path": "bin/npx"}],
            published=sums.get(name),
        )
    return archive_dep("node", version, artifacts)


def gh(version: str) -> dict:
    base = f"https://github.com/cli/cli/releases/download/v{version}"
    sums = published_sums(f"{base}/gh_{version}_checksums.txt")
    artifacts = {}
    for platform, names in PLATFORMS.items():
        name = f"gh_{version}_linux_{names['go']}.tar.gz"
        artifacts[platform] = archive(
            f"{base}/{name}", strip=1, bins=[{"path": "bin/gh"}], published=sums.get(name)
        )
    return archive_dep("gh", version, artifacts)


def amika_release(component: str, version: str) -> dict:
    base = f"{AMIKA_RELEASES}/{component}@v{version}"
    sums = published_sums(f"{base}/checksums.txt")
    artifacts = {}
    for platform, names in PLATFORMS.items():
        name = f"{component}_{version}_linux_{names['go']}.tar.gz"
        artifacts[platform] = archive(
            f"{base}/{name}", strip=1, bins=[{"path": component}], published=sums.get(name)
        )
    return archive_dep(component, version, artifacts)


def codex(version: str) -> dict:
    # OpenAI publishes a static musl build per architecture and no checksum
    # file; the sha256 is pinned from this download.
    base = f"https://github.com/openai/codex/releases/download/rust-v{version}"
    artifacts = {}
    for platform, names in PLATFORMS.items():
        binary = f"codex-{names['rust']}-unknown-linux-musl"
        artifacts[platform] = archive(
            f"{base}/{binary}.tar.gz",
            strip=0,
            bins=[{"path": binary, "name": "codex"}],
            published=None,
        )
    return archive_dep("codex", version, artifacts)


def archive_dep(name: str, version: str, artifacts: dict) -> dict:
    return {"name": name, "version": version, "kind": "archive", "artifacts": artifacts}


def archive(url: str, *, strip: int, bins: list[dict], published: str | None) -> dict:
    data = download(url)
    digest = hashlib.sha256(data).hexdigest()
    if published is not None and published != digest:
        raise SystemExit(f"{url}: sha256 {digest} differs from the published {published}")
    check_bins(url, data, strip, bins)
    return {"url": url, "sha256": digest, "format": "tar.gz", "strip": strip, "bins": bins}


def check_bins(url: str, data: bytes, strip: int, bins: list[dict]) -> None:
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as tar:
        names = set()
        for member in tar.getmembers():
            parts = member.name.lstrip("./").split("/")
            if len(parts) > strip:
                names.add("/".join(parts[strip:]))
    for item in bins:
        if item["path"] not in names:
            raise SystemExit(f"{url}: archive has no {item['path']}")


def npm_dep(name: str, package: str, version: str, *, strict: bool = False) -> dict:
    """An npm dependency. `strict` installs it with --engine-strict and
    --ignore-scripts, as the image build installs Pi and Pi Web."""
    manifest = json.loads(download(f"https://registry.npmjs.org/{package}/{version}"))
    declared = manifest.get("bin") or {}
    if isinstance(declared, str):
        declared = {package.rsplit("/", 1)[-1]: declared}
    if not declared:
        raise SystemExit(f"{package}@{version} declares no commands")
    dep = {
        "name": name,
        "version": version,
        "kind": "npm",
        "package": package,
        "bins": sorted(declared),
    }
    if strict:
        dep["ignore_scripts"] = True
        dep["engine_strict"] = True
    return dep


def published_sums(url: str) -> dict[str, str]:
    sums = {}
    for line in download(url).decode().splitlines():
        parts = line.split()
        if len(parts) == 2:
            sums[parts[1].lstrip("*")] = parts[0]
    return sums


def download(url: str) -> bytes:
    request = urllib.request.Request(url, headers={"User-Agent": "amika-toolchain"})
    with urllib.request.urlopen(request, timeout=300) as response:
        return response.read()


if __name__ == "__main__":
    sys.exit(main())

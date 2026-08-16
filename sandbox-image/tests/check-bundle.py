#!/usr/bin/env python3

from __future__ import annotations

import re
import sys
import tomllib
from pathlib import Path


def main() -> int:
    bundle = Path(__file__).resolve().parent.parent
    manifest = load_toml(bundle / "manifest.toml")
    versions = load_versions(bundle / "versions.env")

    errors = validate_manifest_files(bundle, manifest, versions)
    errors.extend(validate_step_version_literals(bundle))
    errors.extend(validate_generated_dockerfiles(bundle, manifest, versions))

    if errors:
        for error in errors:
            print(error, file=sys.stderr)
        return 1

    print("sandbox image bundle is internally consistent")
    return 0


def load_toml(path: Path) -> dict:
    with path.open("rb") as handle:
        return tomllib.load(handle)


def load_versions(path: Path) -> dict[str, str]:
    versions = {}
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if line and not line.startswith("#"):
            key, value = line.split("=", 1)
            versions[key] = value
    return versions


def validate_manifest_files(
    bundle: Path, manifest: dict, versions: dict[str, str]
) -> list[str]:
    errors = []
    steps = manifest["steps"]
    for preset_name, preset in manifest["presets"].items():
        for step_id in preset["steps"]:
            if step_id not in steps:
                errors.append(f"{preset_name}: unknown step {step_id}")

    for step_id, step in steps.items():
        for relative in [step["script"], *step["assets"]]:
            if not (bundle / relative).exists():
                errors.append(f"{step_id}: missing {relative}")
        for version in step["versions"]:
            if version not in versions:
                errors.append(f"{step_id}: unknown version {version}")
    return errors


def validate_step_version_literals(bundle: Path) -> list[str]:
    errors = []
    version_literal = re.compile(r"(?<![A-Za-z0-9])\d+\.\d+\.\d+(?![A-Za-z0-9])")
    for path in sorted((bundle / "steps").glob("*.sh")):
        for line_number, line in enumerate(
            path.read_text(encoding="utf-8").splitlines(), start=1
        ):
            if version_literal.search(line):
                errors.append(
                    f"{path.relative_to(bundle)}:{line_number}: version literal"
                )
    return errors


def validate_generated_dockerfiles(
    bundle: Path, manifest: dict, versions: dict[str, str]
) -> list[str]:
    errors = []
    steps = manifest["steps"]
    for preset_name, preset in manifest["presets"].items():
        dockerfile = bundle / "generated" / f"{preset_name}.Dockerfile"
        if not dockerfile.is_file():
            errors.append(f"{preset_name}: missing generated Dockerfile")
            continue

        content = dockerfile.read_text(encoding="utf-8")
        arguments = dict(
            re.findall(r"^ARG ([A-Z0-9_]+)=([^\n]+)$", content, re.MULTILINE)
        )
        expected_versions = {
            version
            for step_id in preset["steps"]
            for version in steps[step_id]["versions"]
        }
        expected_versions.add("UBUNTU_TAG")
        for version in sorted(expected_versions):
            if arguments.get(version) != versions[version]:
                errors.append(
                    f"{preset_name}: ARG {version} differs from versions.env"
                )

        positions = []
        for step_id in preset["steps"]:
            reference = f"sandbox-image/{steps[step_id]['script']}"
            position = content.find(reference)
            if position < 0:
                errors.append(f"{preset_name}: missing step {step_id}")
            positions.append(position)
        if positions != sorted(positions):
            errors.append(f"{preset_name}: steps differ from manifest order")
    return errors


if __name__ == "__main__":
    raise SystemExit(main())

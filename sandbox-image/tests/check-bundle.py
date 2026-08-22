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
    errors.extend(validate_regeneration(bundle))

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
    providers = manifest["image"].get("provider_variants", [])
    if (
        not isinstance(providers, list)
        or not all(isinstance(provider, str) and provider for provider in providers)
        or len(set(providers)) != len(providers)
    ):
        errors.append("image.provider_variants: expected unique non-empty strings")
        providers = []
    for preset_name, preset in manifest["presets"].items():
        for position, entry in enumerate(preset["steps"]):
            entry_errors, step_id = validate_step_entry(
                preset_name, position, entry, providers
            )
            errors.extend(entry_errors)
            if step_id is None:
                continue
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


def validate_step_entry(
    preset_name: str,
    position: int,
    entry: object,
    providers: list[str],
) -> tuple[list[str], str | None]:
    label = f"{preset_name}.steps[{position}]"
    if isinstance(entry, str):
        return ([], entry)
    if not isinstance(entry, dict):
        return ([f"{label}: expected a step string or table"], None)
    if set(entry) != {"step", "providers"}:
        return ([f"{label}: expected only step and providers"], None)

    step_id = entry["step"]
    selected_providers = entry["providers"]
    errors = []
    if not isinstance(step_id, str) or not step_id:
        errors.append(f"{label}.step: expected a non-empty string")
        step_id = None
    if (
        not isinstance(selected_providers, list)
        or not selected_providers
        or not all(
            isinstance(provider, str) and provider
            for provider in selected_providers
        )
        or len(set(selected_providers)) != len(selected_providers)
    ):
        errors.append(f"{label}.providers: expected unique non-empty strings")
    else:
        for provider in selected_providers:
            if provider not in providers:
                errors.append(f"{label}: unknown provider {provider}")
    return (errors, step_id)


def preset_step_ids(preset: dict, provider: str | None = None) -> list[str]:
    selected = []
    for entry in preset["steps"]:
        if isinstance(entry, str):
            selected.append(entry)
        elif provider is not None and provider in entry["providers"]:
            selected.append(entry["step"])
    return selected


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
    variants = [(None, "")]
    variants.extend(
        (provider, f"{provider}/")
        for provider in manifest["image"].get("provider_variants", [])
    )
    for (preset_name, preset), (provider, prefix) in (
        (preset_item, variant)
        for preset_item in manifest["presets"].items()
        for variant in variants
    ):
        variant_name = provider or "shared"
        step_ids = preset_step_ids(preset, provider)
        dockerfile = bundle / "generated" / f"{prefix}{preset_name}.Dockerfile"
        if not dockerfile.is_file():
            errors.append(
                f"{preset_name}/{variant_name}: missing generated Dockerfile"
            )
            continue

        content = dockerfile.read_text(encoding="utf-8")
        arguments = dict(
            re.findall(r"^ARG ([A-Z0-9_]+)=([^\n]+)$", content, re.MULTILINE)
        )
        expected_versions = {
            version
            for step_id in step_ids
            for version in steps[step_id]["versions"]
        }
        expected_versions.add("UBUNTU_TAG")
        for version in sorted(expected_versions):
            if arguments.get(version) != versions[version]:
                errors.append(
                    f"{preset_name}/{variant_name}: ARG {version} differs from versions.env"
                )

        positions = []
        for step_id in step_ids:
            reference = f"sandbox-image/{steps[step_id]['script']}"
            position = content.find(reference)
            if position < 0:
                errors.append(
                    f"{preset_name}/{variant_name}: missing step {step_id}"
                )
            positions.append(position)
        if positions != sorted(positions):
            errors.append(
                f"{preset_name}/{variant_name}: steps differ from manifest order"
            )

        excluded_step_ids = set(steps) - set(step_ids)
        for step_id in excluded_step_ids:
            reference = f"sandbox-image/{steps[step_id]['script']}"
            if reference in content:
                errors.append(
                    f"{preset_name}/{variant_name}: unexpected step {step_id}"
                )
    return errors


def validate_regeneration(bundle: Path) -> list[str]:
    import subprocess

    result = subprocess.run(
        [sys.executable, str(bundle / "generate.py"), "--check"], check=False
    )
    if result.returncode == 0:
        return []
    return ["run sandbox-image/generate.py to refresh generated artifacts"]


if __name__ == "__main__":
    raise SystemExit(main())

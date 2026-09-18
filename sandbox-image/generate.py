#!/usr/bin/env python3

from __future__ import annotations

import argparse
import json
import sys
import tomllib
from pathlib import Path


EMBED_SOURCE_DIRECTORIES = ("assets", "steps", "verify")

# The amika CLI agent skill is authored once, at the repository root, which is
# the copy every reader outside this image is pointed at. The image still needs
# one of its own because a bundle must be self-contained: WritePresetBuildContext
# extracts only sandbox-image/, so a generated Dockerfile cannot COPY from above
# it. The generator owns that copy for the same reason it owns the go/ mirror.
# A hand-maintained second copy of a file agents follow literally goes stale in
# silence, and --check turns that into a CI failure instead.
AGENT_SKILL_SOURCE = ".agents/skills/amika-cli"
AGENT_SKILL_BUNDLE = "assets/skills/amika-cli"

# Every step's script and assets are staged here by COPY, then removed by the
# RUN that consumes them. This deliberately avoids /tmp: E2B's builder reboots
# the VM between cached layers, and a boot wipes /tmp, so a COPY into /tmp is
# gone by the time the next layer's RUN reads it.
STAGING_DIRECTORY = "/opt/amika-build"
STAGING_SCRIPT = f"{STAGING_DIRECTORY}/step.sh"
STAGING_ASSETS = f"{STAGING_DIRECTORY}/step-assets"

MAX_DOCKERFILE_COLUMNS = 79


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()

    bundle = Path(__file__).resolve().parent
    manifest = load_toml(bundle / "manifest.toml")
    versions = load_versions(bundle / "versions.env")
    generated = bundle / "generated"
    skill = bundle / AGENT_SKILL_BUNDLE
    embed_root = bundle.parent / "go" / "internal" / "sandbox" / "sandbox-image"

    outputs = build_outputs(manifest, versions)
    skill_outputs = read_tree(bundle.parent / AGENT_SKILL_SOURCE)

    # Checked in both modes, because the manifest is a source file the
    # generator cannot repair: writing the trees while leaving a stale asset
    # list behind would hand the author a bundle that regenerates cleanly and
    # still under-declares what the step installs.
    mismatch = validate_skill_assets(manifest, skill_outputs)
    if mismatch:
        print(mismatch, file=sys.stderr)
        return 1

    if args.check:
        # The skill copy is reported before the embed mirror because the mirror
        # is built from assets/ on disk: a stale skill makes both look stale,
        # and only the first line names the edit that actually diverged.
        for label, root, expected in (
            ("generated sandbox image artifacts", generated, outputs),
            ("bundled agent skill files", skill, skill_outputs),
            (
                "embedded sandbox image artifacts",
                embed_root,
                build_embed_outputs(bundle, outputs),
            ),
        ):
            stale = validate_tree(root, expected)
            if stale:
                print(f"{label} are stale: " + ", ".join(stale), file=sys.stderr)
                return 1
        return 0

    write_tree(generated, outputs)
    # Before the mirror, which embeds assets/ as it finds it on disk.
    write_tree(skill, skill_outputs)
    write_tree(embed_root, build_embed_outputs(bundle, outputs))
    return 0


def build_outputs(manifest: dict, versions: dict[str, str]) -> dict[str, str]:
    image = manifest["image"]
    execution_plan = {
        "schemaVersion": 1,
        "image": {
            key: value
            for key, value in image.items()
            if key != "provider_variants"
        },
        "presets": {},
    }
    outputs = {}
    for preset_name, preset in manifest["presets"].items():
        shared_step_ids = preset_step_ids(preset)
        steps = [
            execution_step(step_id, manifest["steps"][step_id], versions)
            for step_id in shared_step_ids
        ]
        execution_plan["presets"][preset_name] = {
            "steps": steps,
            "binaries": preset["binaries"],
        }
        dockerfile = render_dockerfile(
            preset_name,
            shared_step_ids,
            image,
            manifest["steps"],
            versions,
        )
        outputs[f"{preset_name}.Dockerfile"] = dockerfile
        for provider in image.get("provider_variants", []):
            provider_step_ids = preset_step_ids(preset, provider)
            outputs[f"{provider}/{preset_name}.Dockerfile"] = (
                render_dockerfile(
                    preset_name,
                    provider_step_ids,
                    image,
                    manifest["steps"],
                    versions,
                    provider,
                )
            )

    outputs["bundle.json"] = (
        json.dumps(execution_plan, indent=2, sort_keys=True) + "\n"
    )
    return outputs


def preset_step_ids(preset: dict, provider: str | None = None) -> list[str]:
    """Resolve ordered preset steps for the shared or selected provider build."""
    selected = []
    for entry in preset["steps"]:
        if isinstance(entry, str):
            selected.append(entry)
        elif provider is not None and provider in entry["providers"]:
            selected.append(entry["step"])
    return selected


def validate_skill_assets(manifest: dict, skill_outputs: dict[str, str]) -> str:
    """Reports the agent-skill step declaring assets other than the skill tree.

    The step installs its whole asset directory, so its declared list is the
    one place a new reference file has to be repeated by hand. Nothing at build
    time reads the list -- Docker COPYs the directory and Freestyle uploads the
    bundle wholesale -- which is exactly why a divergence would otherwise sit
    unnoticed in bundle.json until someone read it and believed it.
    """
    expected = sorted(
        f"{AGENT_SKILL_BUNDLE}/{Path(name).as_posix()}" for name in skill_outputs
    )
    declared = manifest["steps"]["agent-skill"]["assets"]
    if declared == expected:
        return ""
    listing = "\n".join(f'  "{name}",' for name in expected)
    return (
        "steps.agent-skill assets do not match "
        f"{AGENT_SKILL_SOURCE}; expected:\nassets = [\n{listing}\n]"
    )


def read_tree(root: Path) -> dict[str, str]:
    """Reads every file under root, keyed by its path relative to root."""
    return {
        str(path.relative_to(root)): path.read_text(encoding="utf-8")
        for path in sorted(root.rglob("*"))
        if path.is_file()
    }


def validate_tree(root: Path, expected: dict[str, str]) -> list[str]:
    """Names under root that differ from expected, in either direction."""
    if not root.is_dir():
        return [f"{root.name}/"]

    stale = []
    actual = {
        str(path.relative_to(root)) for path in root.rglob("*") if path.is_file()
    }
    for name, content in expected.items():
        path = root / name
        if not path.is_file() or path.read_text(encoding="utf-8") != content:
            stale.append(name)
    stale.extend(f"unexpected:{name}" for name in sorted(actual - expected.keys()))
    return stale


def write_tree(root: Path, outputs: dict[str, str]) -> None:
    """Makes root hold exactly outputs, deleting anything else it finds."""
    root.mkdir(parents=True, exist_ok=True)
    expected = set(outputs)
    for path in sorted(root.rglob("*"), reverse=True):
        if path.is_file() and str(path.relative_to(root)) not in expected:
            path.unlink()
        elif path.is_dir() and not any(path.iterdir()):
            path.rmdir()
    for name, content in outputs.items():
        path = root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")


def build_embed_outputs(
    bundle: Path, generated_outputs: dict[str, str]
) -> dict[str, str]:
    outputs = {
        "manifest.toml": (bundle / "manifest.toml").read_text(encoding="utf-8"),
        "versions.env": (bundle / "versions.env").read_text(encoding="utf-8"),
    }
    for directory in EMBED_SOURCE_DIRECTORIES:
        for path in sorted((bundle / directory).rglob("*")):
            if path.is_file():
                outputs[str(path.relative_to(bundle))] = path.read_text(
                    encoding="utf-8"
                )
    for name, content in generated_outputs.items():
        outputs[f"generated/{name}"] = content
    return outputs


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


def execution_step(
    step_id: str, step: dict, versions: dict[str, str]
) -> dict:
    result = {
        "id": step_id,
        "script": step["script"],
        "versions": {name: versions[name] for name in step["versions"]},
        "assets": step["assets"],
    }
    for key in ("asset_argument", "preset_environment"):
        if key in step:
            result[key] = step[key]
    return result


def render_dockerfile(
    preset_name: str,
    step_ids: list[str],
    image: dict,
    steps: dict,
    versions: dict[str, str],
    provider: str | None = None,
) -> str:
    base_version = image["base_version"]
    lines = [
        "# syntax=docker/dockerfile:1",
        "",
        f"ARG {base_version}={versions[base_version]}",
        f"FROM {image['base_image']}:${{{base_version}}}",
        "",
        "ENV DEBIAN_FRONTEND=noninteractive",
        "ENV LANG=C.UTF-8",
    ]

    for step_id in step_ids:
        step = steps[step_id]
        lines.append("")
        for version in step["versions"]:
            lines.append(f"ARG {version}={versions[version]}")

        asset_argument = step.get("asset_argument")
        if asset_argument:
            lines.append(
                f"COPY sandbox-image/{asset_argument} {STAGING_ASSETS}"
            )
        for copy in step.get("docker_copies", []):
            lines.append(
                f"COPY sandbox-image/{copy['source']} {copy['destination']}"
            )

        lines.append(f"COPY sandbox-image/{step['script']} {STAGING_SCRIPT}")
        command = []
        if provider is not None and step_id == "verify":
            command.append(f"AMIKA_IMAGE_PROVIDER={provider}")
        preset_environment = step.get("preset_environment")
        if preset_environment:
            command.append(f"{preset_environment}={preset_name}")
        command.append(STAGING_SCRIPT)
        if asset_argument:
            command.append(STAGING_ASSETS)
        lines.extend(render_run(command))

    lines.extend(
        [
            "",
            f"USER {image['runtime_user']}",
            f"ENV HOME={image['runtime_home']}",
            f"WORKDIR {image['runtime_home']}",
            "",
        ]
    )
    return "\n".join(lines)


def render_run(command: list[str]) -> list[str]:
    """Runs a staged step, then clears the staging directory it read from.

    Removing the whole directory, rather than the paths the step used, keeps
    the image free of an empty /opt/amika-build once the build finishes.
    """
    command_text = " ".join(command)
    single_line = f"RUN {command_text} && rm -rf {STAGING_DIRECTORY}"
    if len(single_line) <= MAX_DOCKERFILE_COLUMNS:
        return [single_line]
    return [
        f"RUN {command_text} \\",
        f"    && rm -rf {STAGING_DIRECTORY}",
    ]


if __name__ == "__main__":
    raise SystemExit(main())

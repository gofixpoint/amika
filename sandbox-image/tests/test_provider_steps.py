#!/usr/bin/env python3

from __future__ import annotations

import importlib.util
import unittest
from pathlib import Path


BUNDLE = Path(__file__).resolve().parent.parent


def load_module(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"could not load {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


generate = load_module("sandbox_image_generate", BUNDLE / "generate.py")
check_bundle = load_module(
    "sandbox_image_check_bundle", BUNDLE / "tests" / "check-bundle.py"
)


class ProviderStepTests(unittest.TestCase):
    def setUp(self) -> None:
        self.preset = {
            "steps": [
                "shared-before",
                {"step": "daytona-only", "providers": ["daytona"]},
                {"step": "both", "providers": ["daytona", "e2b"]},
                "shared-after",
            ]
        }

    def test_shared_output_omits_provider_steps(self) -> None:
        self.assertEqual(
            generate.preset_step_ids(self.preset),
            ["shared-before", "shared-after"],
        )

    def test_provider_output_filters_without_reordering(self) -> None:
        self.assertEqual(
            generate.preset_step_ids(self.preset, "daytona"),
            ["shared-before", "daytona-only", "both", "shared-after"],
        )
        self.assertEqual(
            generate.preset_step_ids(self.preset, "e2b"),
            ["shared-before", "both", "shared-after"],
        )

    def test_validator_rejects_unknown_provider(self) -> None:
        errors, step_id = check_bundle.validate_step_entry(
            "coder",
            1,
            {"step": "conditional", "providers": ["missing"]},
            ["daytona", "e2b"],
        )
        self.assertEqual(step_id, "conditional")
        self.assertEqual(errors, ["coder.steps[1]: unknown provider missing"])

    def test_validator_requires_exact_object_shape(self) -> None:
        errors, step_id = check_bundle.validate_step_entry(
            "coder",
            1,
            {
                "step": "conditional",
                "providers": ["daytona"],
                "after": "runtime-user",
            },
            ["daytona", "e2b"],
        )
        self.assertIsNone(step_id)
        self.assertEqual(
            errors, ["coder.steps[1]: expected only step and providers"]
        )


if __name__ == "__main__":
    unittest.main()

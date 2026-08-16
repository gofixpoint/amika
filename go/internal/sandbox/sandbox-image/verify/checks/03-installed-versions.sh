#!/bin/bash
# shellcheck disable=SC1091,SC2034
CHECK_ID="installed-versions"
CHECK_CONTEXTS="build,boot"
source "$(dirname "$0")/../lib/check.sh" "$@"

result="$(python3 - "$MANIFEST_PATH" "$VERSIONS_PATH" "$PRESET" "$(runtime_user)" "$(runtime_home)" "$(standard_path)" <<'PY'
import os
import subprocess
import sys
import tomllib

manifest_path, versions_path, preset, user, home, path = sys.argv[1:]
with open(manifest_path, "rb") as handle:
    manifest = tomllib.load(handle)
versions = {}
with open(versions_path, encoding="utf-8") as handle:
    for raw_line in handle:
        line = raw_line.strip()
        if line and not line.startswith("#"):
            key, value = line.split("=", 1)
            versions[key] = value

failures = []
checked = []
for check in manifest["version_checks"]:
    if check.get("presets") and preset not in check["presets"]:
        continue
    expected = versions[check["env"]]
    command = ["sudo", "-u", user, "env", f"HOME={home}", f"PATH={path}", *check["command"]]
    completed = subprocess.run(command, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    actual = completed.stdout.strip().replace("\n", " | ")
    checked.append(check["id"])
    if completed.returncode != 0 or expected not in actual:
        failures.append(f'{check["id"]}: expected {expected}, got {actual or "exit " + str(completed.returncode)}')
print("; ".join(failures) if failures else "matched: " + ",".join(checked))
PY
)"

case "$result" in
  matched:*) pass "every applicable version matches versions.env" "$result" ;;
  *) fail "every applicable version matches versions.env" "$result" ;;
esac

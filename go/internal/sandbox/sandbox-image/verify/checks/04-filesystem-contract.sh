#!/bin/bash
# Verifies declared image directories have the required owners and permissions.
# shellcheck disable=SC1091,SC2034
CHECK_ID="filesystem-contract"
CHECK_CONTEXTS="build,boot"
source "$(dirname "$0")/../lib/check.sh" "$@"

result="$(python3 - "$MANIFEST_PATH" <<'PY'
import os
import pwd
import grp
import stat
import sys
import tomllib

with open(sys.argv[1], "rb") as handle:
    directories = tomllib.load(handle)["image"]["directories"]
failures = []
for item in directories:
    path = item["path"]
    try:
        info = os.stat(path)
    except FileNotFoundError:
        failures.append(f"{path}=missing")
        continue
    actual = (pwd.getpwuid(info.st_uid).pw_name, grp.getgrgid(info.st_gid).gr_name, format(stat.S_IMODE(info.st_mode), "o"))
    expected = (item["owner"], item["group"], item["mode"])
    if actual != expected:
        failures.append(f"{path}={actual[0]}:{actual[1]}:{actual[2]}")
print("; ".join(failures) if failures else "all directories match")
PY
)"

[[ "$result" == "all directories match" ]] && pass "manifest directory owners and modes" "$result"
fail "manifest directory owners and modes" "$result"

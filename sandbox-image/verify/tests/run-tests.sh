#!/bin/bash
# Tests metadata filtering and result accounting in the verification harness.

set -euo pipefail

verify_dir="$(cd "$(dirname "$0")/.." && pwd)"
metadata_dir="$(cd "$verify_dir/../" && pwd)"

for check in "$verify_dir"/checks/*.sh; do
  record="$($check --metadata)"
  python3 - "$record" <<'PY'
import json
import sys

record = json.loads(sys.argv[1])
assert set(record) == {"id", "contexts"}
assert record["id"]
assert set(record["contexts"]).issubset({"build", "boot"})
assert record["contexts"]
PY
done

AMIKA_IMAGE_METADATA_DIR="$metadata_dir" \
  python3 "$verify_dir/lib/manifest.py" "$metadata_dir/manifest.toml" presets.coder.binaries lines \
  | grep -qx amikad

records="$(AMIKA_VERIFY_CHECKS_DIR="$verify_dir/tests/fixtures" "$verify_dir/run.sh" build)"
python3 - "$records" <<'PY'
import json
import sys

records = [json.loads(line) for line in sys.argv[1].splitlines()]
assert records
assert {record["status"] for record in records} == {"passed", "skipped"}
assert len({record["id"] for record in records}) == len(records)
for record in records:
    assert set(record) == {"id", "status", "expected", "actual"}
    assert record["status"] in {"passed", "failed", "skipped"}
PY

echo "verification harness tests passed"

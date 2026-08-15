#!/bin/bash

set -u

context="${1:-}"
case "$context" in
  build|boot) ;;
  *) echo "usage: $0 <build|boot>" >&2; exit 64 ;;
esac

verify_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
checks_dir="${AMIKA_VERIFY_CHECKS_DIR:-$verify_dir/checks}"
failed=0
skipped=0
passed=0
total=0

while IFS= read -r check; do
  metadata="$($check --metadata)"
  applies="$(python3 - "$metadata" "$context" <<'PY'
import json
import sys

print("yes" if sys.argv[2] in json.loads(sys.argv[1])["contexts"] else "no")
PY
)"
  [[ "$applies" == "yes" ]] || continue

  record="$($check 2>&1)"
  if [[ "$(printf '%s\n' "$record" | wc -l | tr -d ' ')" != "1" ]]; then
    id="$(python3 - "$metadata" <<'PY' 2>/dev/null || basename "$check" .sh
import json
import sys

print(json.loads(sys.argv[1])["id"])
PY
)"
    record="$(python3 - "$id" "$record" <<'PY'
import json
import sys

print(json.dumps({"id": sys.argv[1], "status": "failed", "expected": "one JSON record", "actual": sys.argv[2]}, separators=(",", ":")))
PY
)"
  fi

  status="$(python3 - "$record" <<'PY'
import json
import sys

try:
    record = json.loads(sys.argv[1])
    if sorted(record) != ["actual", "expected", "id", "status"]:
        raise ValueError("record keys differ from contract")
    if record["status"] not in ("passed", "failed", "skipped"):
        raise ValueError("invalid status")
    print(record["status"])
except Exception:
    print("invalid")
PY
)"
  if [[ "$status" == "invalid" ]]; then
    record="$(python3 - "$record" <<'PY'
import json
import sys

print(json.dumps({"id": "invalid-check-output", "status": "failed", "expected": "valid check record", "actual": sys.argv[1]}, separators=(",", ":")))
PY
)"
    status=failed
  fi

  printf '%s\n' "$record"
  total=$((total + 1))
  case "$status" in
    passed) passed=$((passed + 1)) ;;
    failed) failed=$((failed + 1)) ;;
    skipped) skipped=$((skipped + 1)) ;;
  esac
done < <(find "$checks_dir" -type f -name '*.sh' -perm -u+x | sort)

printf 'verification: %d passed, %d failed, %d skipped (%d total)\n' "$passed" "$failed" "$skipped" "$total" >&2
[[ "$failed" -eq 0 ]]

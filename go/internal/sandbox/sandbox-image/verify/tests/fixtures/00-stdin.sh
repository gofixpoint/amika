#!/bin/bash
# Supplies a check fixture that reads all of stdin, as script or ssh would.
if [[ "${1:-}" == "--metadata" ]]; then
  printf '%s\n' '{"id":"fixture-stdin","contexts":["build"]}'
else
  cat >/dev/null
  printf '%s\n' '{"id":"fixture-stdin","status":"passed","expected":"pass","actual":"pass"}'
fi

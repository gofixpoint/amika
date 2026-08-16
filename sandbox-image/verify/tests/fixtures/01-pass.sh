#!/bin/bash
# Supplies a deterministic passing check fixture for the verification harness.
if [[ "${1:-}" == "--metadata" ]]; then
  printf '%s\n' '{"id":"fixture-pass","contexts":["build"]}'
else
  printf '%s\n' '{"id":"fixture-pass","status":"passed","expected":"pass","actual":"pass"}'
fi

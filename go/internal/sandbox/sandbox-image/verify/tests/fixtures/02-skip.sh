#!/bin/bash
if [[ "${1:-}" == "--metadata" ]]; then
  printf '%s\n' '{"id":"fixture-skip","contexts":["build","boot"]}'
else
  printf '%s\n' '{"id":"fixture-skip","status":"skipped","expected":"external input","actual":"not supplied"}'
fi

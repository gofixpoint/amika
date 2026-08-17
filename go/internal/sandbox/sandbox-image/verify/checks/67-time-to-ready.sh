#!/bin/bash
# Verifies a provider reports its measured sandbox readiness time.
# shellcheck disable=SC1091,SC2034
CHECK_ID="time-to-ready"
CHECK_CONTEXTS="boot"
source "$(dirname "$0")/../lib/check.sh" "$@"

[[ "${AMIKA_VERIFY_TIME_TO_READY_MS:-}" =~ ^[0-9]+$ ]] || skip "provider reports time-to-ready metric" "AMIKA_VERIFY_TIME_TO_READY_MS not supplied by provider adapter"
pass "provider reports time-to-ready metric" "${AMIKA_VERIFY_TIME_TO_READY_MS}ms"

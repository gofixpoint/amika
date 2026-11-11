#!/usr/bin/env python3
"""Prefix each stdin line with the local receive time. Flushes each line."""
import sys
import time

for line in sys.stdin:
    sys.stdout.write(f"{time.time():.3f} {line}")
    sys.stdout.flush()

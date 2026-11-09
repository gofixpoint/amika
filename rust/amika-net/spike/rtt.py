#!/usr/bin/env python3
"""Interactive round trip over SSH (test 5).

Usage: rtt.py <label> <samples> <ssh args...>

Runs `ssh <args> cat`, waits until the echo works, then sends one short
line every 50 ms and times each echo. Prints p50, p95, max as JSON.
"""
import json
import os
import select
import statistics
import subprocess
import sys
import time

label, samples, ssh_args = sys.argv[1], int(sys.argv[2]), sys.argv[3:]
p = subprocess.Popen(["ssh", *ssh_args, "cat"], stdin=subprocess.PIPE, stdout=subprocess.PIPE, bufsize=0)
fd = p.stdout.fileno()


def echo(payload: bytes, timeout: float) -> float:
    t = time.perf_counter()
    p.stdin.write(payload)
    got = b""
    while not got.endswith(b"\n"):
        r, _, _ = select.select([fd], [], [], timeout)
        if not r:
            raise TimeoutError("no echo")
        chunk = os.read(fd, 4096)
        if not chunk:
            raise EOFError("ssh closed")
        got += chunk
    return (time.perf_counter() - t) * 1000


# Warm up: the first echoes include the dial and path setup.
for i in range(20):
    echo(b"warm%d\n" % i, 30)
    time.sleep(0.05)
time.sleep(2)
rtts = []
for i in range(samples):
    rtts.append(echo(b"x%06d\n" % i, 10))
    time.sleep(0.05)
p.stdin.close()
p.wait(timeout=10)
rtts.sort()
q = lambda f: rtts[min(len(rtts) - 1, int(round(f * (len(rtts) - 1))))]
print(json.dumps({"label": label, "n": len(rtts), "p50_ms": round(q(0.5), 2),
                  "p95_ms": round(q(0.95), 2), "max_ms": round(rtts[-1], 2),
                  "mean_ms": round(statistics.mean(rtts), 2)}))

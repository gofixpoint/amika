#!/usr/bin/env python3
"""Per-event output pause for tests 1 and 2.

Usage: gaps.py <marks.log> <stream.log> [<stream.log> ...]

marks.log has "<ts> switch-start <label>" lines, and optionally
"<ts> switch-end <label>" lines (test 1 writes them when the blackout
ends). A stream log has "<recv_ts> <remote line>" lines from stamp.py, one
every 0.1 s.

For each event, the window runs from 1 s before the event to the next
event (or 120 s after the last one). The stream survived the event only if
a line arrives after the outage ended: after the switch-end mark, or 3 s
after the switch-start mark when there is no switch-end mark. The pause is
the longest gap between lines in the window.
"""
import statistics
import sys


def load_marks(path):
    starts, ends = [], []
    for line in open(path):
        parts = line.split()
        if len(parts) >= 3 and parts[1] == "switch-start":
            starts.append((float(parts[0]), parts[2]))
        elif len(parts) >= 3 and parts[1] == "switch-end":
            ends.append(float(parts[0]))
    return starts, ends


def load_stream(path):
    out = []
    for line in open(path):
        try:
            out.append(float(line.split()[0]))
        except (ValueError, IndexError):
            pass
    return out


def main():
    starts, ends = load_marks(sys.argv[1])
    for spath in sys.argv[2:]:
        ts = load_stream(spath)
        print(f"== {spath}: {len(ts)} lines")
        pauses = []
        for i, (t0, what) in enumerate(starts):
            end = starts[i + 1][0] if i + 1 < len(starts) else t0 + 120
            outage_end = next((e for e in ends if t0 <= e <= end), t0 + 3.0)
            window = [t for t in ts if t0 - 1 <= t <= end]
            if not any(t > outage_end for t in window):
                print(f"event {i + 1} {what}: session ended (no line after the outage)")
                break
            gaps = [b - a for a, b in zip(window, window[1:])]
            pause = max(gaps) if gaps else float("nan")
            pauses.append(pause)
            print(f"event {i + 1} {what}: pause {pause:.2f} s")
        if pauses:
            pauses.sort()
            p95 = pauses[min(len(pauses) - 1, int(round(0.95 * (len(pauses) - 1))))]
            print(
                f"survived {len(pauses)}/{len(starts)}; pause min {pauses[0]:.2f} "
                f"median {statistics.median(pauses):.2f} p95 {p95:.2f} max {pauses[-1]:.2f} s"
            )


if __name__ == "__main__":
    main()

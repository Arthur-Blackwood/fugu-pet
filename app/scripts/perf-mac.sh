#!/usr/bin/env bash
# Measure the pet's CPU usage on macOS from CPU-time deltas: the app process plus
# WebKit's helper processes (WebContent runs the page, GPU does the WebGL work).
# Usage: scripts/perf-mac.sh [seconds=30]
# WebKit helpers are shared with Safari/Mail etc.; quit those first for a clean number.
set -euo pipefail
secs=${1:-30}

snap() { ps -A -o pid=,time=,comm= | grep -E 'fugu-pet|Fugu Pet|com\.apple\.WebKit\.(WebContent|GPU)' || true; }

before=$(snap)
sleep "$secs"
after=$(snap)

awk -v secs="$secs" '
  function cpu(t,   p, n) {            # [[dd-]hh:]mm:ss.ss -> seconds
    n = split(t, p, ":")
    return n == 3 ? p[1] * 3600 + p[2] * 60 + p[3] : p[1] * 60 + p[2]
  }
  function kind(c) { return c ~ /GPU/ ? "WebKit GPU" : c ~ /WebContent/ ? "WebKit content" : "app process" }
  FNR == NR { t0[$1] = cpu($2); next }
  { k = kind($0); d = cpu($2) - ($1 in t0 ? t0[$1] : 0); sum[k] += d; total += d }
  END {
    printf "CPU over %ds (%% of one core)\n", secs
    for (k in sum) printf "  %-15s %6.2f\n", k, 100 * sum[k] / secs
    printf "  %-15s %6.2f\n", "total", 100 * total / secs
  }' <(echo "$before") <(echo "$after")

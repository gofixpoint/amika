#!/bin/bash
# Throughput (test 4): copy 1 GB from the host VM with scp, per SSH alias.
# For a slow path, stream for at most LIMIT seconds and report the rate.
# Usage: tput.sh <alias> [scp|stream] [limit-s]
set -uo pipefail
alias=$1; mode=${2:-scp}; limit=${3:-600}
start=$(date +%s.%N)
if [ "$mode" = scp ]; then
  timeout "$limit" scp -q -o Compression=no "$alias:/tmp/1g.bin" /dev/null
  rc=$?
  bytes=1073741824
  [ $rc -eq 0 ] || bytes=0
else
  bytes=$(timeout "$limit" ssh -o Compression=no "$alias" 'cat /tmp/1g.bin' | wc -c)
  rc=$?
fi
end=$(date +%s.%N)
python3 -c "import json,sys; s=float(sys.argv[3])-float(sys.argv[2]); b=int(sys.argv[4]); print(json.dumps({'alias':sys.argv[1],'mode':sys.argv[5],'rc':int(sys.argv[6]),'bytes':b,'secs':round(s,2),'MBps':round(b/s/1e6,2),'Mbps':round(b*8/s/1e6,1)}))" \
  "$alias" "$start" "$end" "$bytes" "$mode" "$rc"

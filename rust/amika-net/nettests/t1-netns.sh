#!/bin/bash
# Test 1 rig on the client VM (run as root).
#
# A network namespace "lap" plays the laptop. It sits behind NAT, with two
# uplinks: network A ($DEV_A, 192.168.10.0/24) and network B ($DEV_B,
# 192.168.20.0/24). Each uplink has its own external IP. A "network change"
# is: drop all lap traffic for BLACKOUT seconds, move lap's address and
# default route to the other network, flush conntrack, end the drop.
#
# Usage: t1-netns.sh setup | switch | teardown | which
#
# Set these for the machine (no defaults):
#   DEV_A, GW_A   uplink A: interface and its gateway
#   DEV_B, GW_B   uplink B: interface and its gateway
#   BLOCK_NET     a local subnet that the namespace must not reach directly
#                 (for example the subnet the host shares with the client)
set -euo pipefail
BLACKOUT=${BLACKOUT:-3}
: "${DEV_A:?}" "${GW_A:?}" "${DEV_B:?}" "${GW_B:?}" "${BLOCK_NET:?}"

setup() {
  ip netns add lap
  ip link add rlap0 type veth peer name lap0
  ip link set lap0 netns lap
  ip addr add 192.168.10.1/24 dev rlap0
  ip addr add 192.168.20.1/24 dev rlap0
  # Match the uplink MTU (GCE uses 1460). A larger veth MTU black-holes
  # large TCP segments, which breaks relay connections from the namespace.
  ip link set rlap0 mtu 1460 up
  ip netns exec lap ip link set lo up
  ip netns exec lap ip link set lap0 mtu 1460 up
  ip netns exec lap ip addr add 192.168.10.2/24 dev lap0
  ip netns exec lap ip route add default via 192.168.10.1
  sysctl -qw net.ipv4.ip_forward=1
  for i in all default "$DEV_A" "$DEV_B" rlap0; do sysctl -qw net.ipv4.conf.$i.rp_filter=0; done
  ip route add default via "$GW_A" dev "$DEV_A" onlink table 110
  ip route add default via "$GW_B" dev "$DEV_B" onlink table 120
  ip rule add from 192.168.10.0/24 table 110 prio 110
  ip rule add from 192.168.20.0/24 table 120 prio 120
  iptables -t nat -A POSTROUTING -s 192.168.10.0/24 -o "$DEV_A" -j MASQUERADE
  iptables -t nat -A POSTROUTING -s 192.168.20.0/24 -o "$DEV_B" -j MASQUERADE
  # Keep lap off the VPC: its paths to the host must cross the internet.
  iptables -I FORWARD -d "$BLOCK_NET" -j DROP
  mkdir -p /etc/netns/lap
  echo "nameserver 8.8.8.8" > /etc/netns/lap/resolv.conf
}

which_net() {
  if ip netns exec lap ip -4 addr show lap0 | grep -q 192.168.10.2; then echo A; else echo B; fi
}

switch() {
  local from to
  from=$(which_net)
  if [ "$from" = A ]; then to=B; else to=A; fi
  local old new
  old=$([ "$from" = A ] && echo 10 || echo 20)
  new=$([ "$to" = A ] && echo 10 || echo 20)
  echo "$(date +%s.%N) switch-start $from->$to"
  ip netns exec lap tc qdisc add dev lap0 root netem loss 100%
  tc qdisc add dev rlap0 root netem loss 100%
  sleep "$BLACKOUT"
  ip netns exec lap ip addr del 192.168.$old.2/24 dev lap0
  ip netns exec lap ip addr add 192.168.$new.2/24 dev lap0
  ip netns exec lap ip route replace default via 192.168.$new.1
  conntrack -F >/dev/null 2>&1 || true
  ip netns exec lap tc qdisc del dev lap0 root
  tc qdisc del dev rlap0 root
  echo "$(date +%s.%N) switch-end $from->$to"
}

teardown() {
  ip netns del lap 2>/dev/null || true
  ip link del rlap0 2>/dev/null || true
  ip rule del from 192.168.10.0/24 table 110 2>/dev/null || true
  ip rule del from 192.168.20.0/24 table 120 2>/dev/null || true
  ip route flush table 110 2>/dev/null || true
  ip route flush table 120 2>/dev/null || true
  iptables -t nat -D POSTROUTING -s 192.168.10.0/24 -o "$DEV_A" -j MASQUERADE 2>/dev/null || true
  iptables -t nat -D POSTROUTING -s 192.168.20.0/24 -o "$DEV_B" -j MASQUERADE 2>/dev/null || true
  iptables -D FORWARD -d "$BLOCK_NET" -j DROP 2>/dev/null || true
}

case ${1:-} in
  setup) setup ;;
  switch) switch ;;
  teardown) teardown ;;
  which) which_net ;;
  *) echo "usage: $0 setup|switch|teardown|which" >&2; exit 2 ;;
esac

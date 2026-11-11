# amika-net

`amika-net` carries SSH and TCP streams to Amika hosts over iroh (QUIC).
It is one Rust binary with three roles:

- `host`: a sidecar that `amika-hostd` starts. It runs check 1 and check 2
  through hostd's control socket, then copies bytes to the target.
- `connect`: the SSH `ProxyCommand` that the CLI starts.
- `agent`: one process per user that holds the device key for every
  `connect`.

The interfaces (control socket, stream header, key formats) are fixed in
amika-mono `specs/035-host-connection-drops.d/iroh-contracts.md`. Do not
change them here alone. Change that document first, and tell the owners of
hostd, the CLI and the control plane.

## Commands

Run these from `rust/amika-net/`:

```bash
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test
cargo test -- --ignored   # needs the internet; the n0 Pro test also needs
                          # TEST_AMIKA_NET_N0_API_SECRET_FILE and
                          # TEST_AMIKA_NET_N0_RELAY_URLS_FILE
```

## Layout

- `src/lib.rs`: the library. Other crates (the dialer) use it as a path
  dependency for the header, the targets and the endpoint builder.
  `src/main.rs` is only the command line. Put new code in the library.
- `src/host/`: the host role. `control.rs` is the control socket client.
  `registry.rs` closes connections on `revoke`. `allowlist.rs` is a test
  mode with no hostd (`--test-allowlist`).
- `src/connect.rs`: the connect role, and the dial that the agent uses.
- `src/agent/`: the per-user agent. `mod.rs` records its design.
- `src/header.rs`: the stream header and refusal reasons.
- `src/net.rs`: relay choice, relay tokens and QUIC settings.
- `src/keys.rs`: key files (base64 seed) and the host key on a descriptor.
- `tests/`: end-to-end tests. They run the real binary against a fake
  hostd on one machine.
- `nettests/`: scripts that measure network changes, relay restarts,
  throughput and soak on VMs.

## Relay tokens

An n0 Pro relay token expires after 30 days. Each endpoint signs its own
token with the n0 project API secret.

- At 80% of a token's lifetime, the endpoint makes a new token and puts it
  in its relay map for each known relay (`Relays::spawn_refresh`). The
  host role and the agent do this.
- iroh 1.4.1 cannot swap the token of a live relay connection. It reads
  the token when it starts a relay connection, and keeps it for all of that
  connection's reconnects. Its public API cannot restart one relay
  connection. Only a rebind of the endpoint can, and a rebind ends every
  session. So the refresh does not touch live connections.
- Effect: a relay connection that iroh starts after a refresh uses the new
  token. The home relay connection never ends on its own, so it keeps the
  first token. The relay checks the token only when a relay connection
  starts: an open relay connection continues past the token's expiry. The
  test `an_n0_pro_session_survives_relay_token_refreshes` showed this on
  n0's relays.
- Risk: if the home relay connection drops after the first token expires,
  it cannot come back. Relay-only sessions then end, and new callers cannot
  reach the host. Sessions on direct paths continue.
- Recovery: when the home relay refuses the token after a refresh, the
  host role waits until it has no open connections, then exits with an
  error. hostd starts it again with a new token. The host never cuts a
  session that still works.
- Remove the recovery exit when iroh can restart a relay connection or
  swap its token.

## Rules

- Keep address lookup off. A caller dials by endpoint id and relay URL
  from Amika's control plane.
- Keep `iroh` pinned to an exact version. On an upgrade, run the scripts in
  `nettests/` again: the outage and relay limits come from iroh internals.
- Never log key material or relay tokens.
- Put test-only flags behind `hide = true`, with a name or doc that says
  they are for tests.
- Windows builds `connect` (direct, with no agent) and `id` only. Keep it
  compiling.

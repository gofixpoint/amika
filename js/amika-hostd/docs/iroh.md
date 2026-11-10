# The iroh transport

hostd's side of spec 035's iroh transport, track B phase 1. The interfaces
are in amika-mono's `specs/035-host-connection-drops.d/iroh-contracts.md`.
Change them there first.

## When `amika-net` runs

- `transport = "tunnel_iroh"` is a `tunnel` host that also runs
  `amika-net host`. The value is not documented for users. Keep it out of
  `config.example.toml`, the README and the setup skill.
- A `tunnel_iroh` host keeps the gateway tunnel in every case. Test for
  the tunnel with `dialsGateway(mode)`, never with `mode === "tunnel"`.
- `up` registers with `transport_mode: "tunnel_iroh"` and
  `iroh_rules: { formats, features }` from `@amika/iroh-rules`.
- The daemon runs `amika-net` only when the registration answer's
  `org_allowed_transport_modes` contains `tunnel_iroh`
  (`irohHandoff` in `cli.ts`).
- The daemon finds `amika-net` next to the hostd script, then on `PATH`
  (`findAmikaNet`). Without it, the daemon logs one line and runs without
  it.
- The daemon stops `amika-net` when the rules answer `404`, or when a
  report's answer leaves `tunnel_iroh` out. The rules loop goes on. When
  an answer shows the org allows the mode again, the daemon starts
  `amika-net` again.

## Keys and secrets

- The host key is a 32-byte Ed25519 seed. It is the `iroh-key` item in
  hostd's secret store, as hex (`iroh-host-key.ts`). It is never in
  `config.toml`.
- `up` reads the key, or makes it on first use. `up` hands the key, the
  API key, the host id, the hostname and the org id to the daemon over IPC
  (`HandedIroh` in `daemon.ts`). The daemon never opens the store.
- The daemon writes the key to `amika-net`'s fd 3 and closes its end
  (`amika-net-supervisor.ts`). The key is never in an argument, the
  environment or a log line.
- `amika-net` gets the daemon's environment without the API key and the
  secret key.
- In this mode the daemon holds the API key. It needs it to fetch the
  rules and to send the `amika_net` report.

## The control socket

- The socket is `<state dir>/amika-net/control.sock`. The directory is mode
  0700 and the socket is mode 0600 (`amika-net-control.ts`).
- `iroh-access.ts` answers `check_peer` and `open` from the rules hostd
  holds. With no rules, it refuses every peer.
- `open` checks the rules before it looks up the rig, so a refused caller
  learns nothing about which rigs exist.
- A rig target connects to the port the rig's runtime publishes on
  loopback (`MachineRuntime.hostPort`), as service routes do.
- The `hostd` target is answered by peer (`iroh-listeners.ts`):
  - The `dialer` service gets the preview listener. It serves a stream as
    the tunnel's server does: `x-amika-rig` and `x-amika-service` route
    the request, and every other `x-amika-` header is removed.
  - The `control_plane` service gets the API listener. The host key is
    checked there, and the rig headers are ignored.
  - Any other peer gets `not_allowed`.
- Both listeners bind only to `127.0.0.1`. The preview listener takes one
  connection for each `open` answer that names it, within 10 s. It closes
  every other connection at once.

## Rules

- `iroh-rules-sync.ts` fetches
  `GET /api/v0beta1/hosts/{id}/iroh-rules?have=<version>` at start and
  every 60 s. It leaves out `have` when it holds no rules.
- It verifies each record with `verifyRules`. A refused record leaves the
  old rules in place, and the reason goes to the log.
- The next report carries the refusal in the `amika_net` entry:
  `rules_refusal: { reason, version, at }`. `version` is the refused
  record's version, or null when it cannot be read. `at` is milliseconds
  since the Unix epoch. The same record refused again keeps its first
  `at`. The field is cleared when a record is accepted.
- It keeps the newest accepted envelope in `<state dir>/iroh-rules.json`,
  mode 0600, and verifies it again at start.
- It logs the version and signer of each accepted record, for audit.
- When new rules drop a device or a service, it sends `revoke` for its
  endpoint ids.
- The trusted keys are `BUILT_IN_TRUSTED_KEYS`, one list for each API URL.
  The lists are empty until a human adds Amika's public keys. The config
  key `iroh_rules_trusted_keys` replaces the list, for tests and local
  development only.

## Rig owners

- `POST /v0beta1/rigs` takes an optional `owner: { kind: "user", id }`.
  hostd refuses any other kind with `400`.
- `rig-owners.ts` keeps the owners in `<state dir>/rig-owners.json`.
  Delete removes the owner.
- `/health` names the `rig-owner` feature. A control plane sends `owner`
  only to a host that names it.

## Reports

- The daemon sends `PUT /api/v0beta1/hosts/{id}` with
  `capabilities.amika_net: { endpoint_id, relay_url, version }` when
  `amika-net` sends `ready`, and again on `home_relay`. A failed report is
  sent again after 60 s.
- The daemon writes the last report to `<state dir>/amika-net.json`. The
  file stays when the daemon stops. The daemon removes it when the org
  stops allowing the mode.

## Tests

- `src/testing/iroh.ts` holds the test fixtures: `@amika/iroh-rules`'s
  test vectors, records signed with RFC 8032 test keys, and a fake
  `amika-net` that speaks the control socket contract. Never use real
  keys.

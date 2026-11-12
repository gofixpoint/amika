# @amika/tunnel-protocol

`amika.tunnel.v2` and `amika.tunnel.v3`: the frames amika-hostd and
Amika's per-host relay exchange over a host's tunnel WebSocket. v3 is v2
plus a cumulative `ACK` frame and a resume handshake. The design is
amika-mono's `specs/035-host-connection-drops.d/resumable-tunnel.md`.

| Entry point                     | What it holds                                         |
| ------------------------------- | ----------------------------------------------------- |
| `@amika/tunnel-protocol`        | The codec, the head schemas and every shared constant |
| `@amika/tunnel-protocol/resume` | v3 counting: the replay log and the `ACK` schedule    |
| `@amika/tunnel-protocol/window` | Credit accounting for `DATA`, one per direction       |

## Rules

- **A constant that must agree at both ends lives here and nowhere else.**
  Nothing negotiates the limits, so a copy that drifts breaks the tunnel on
  the first frame that crosses the difference.
- **It runs in a Cloudflare Worker as well as Node.** Use `Uint8Array`,
  `DataView` and `TextEncoder`. No `Buffer` and no `node:` import.
- **A sender checks a head before it sends it.** `isSendableRequestHead`
  and `isSendableResponseHead` apply exactly the schema `decodeFrame`
  applies. A head that breaks it is decoded as `MalformedHeadError`, which
  names the stream, so a receiver can refuse that stream alone.
- **A change to the wire format is a new subprotocol.** Hosts and the
  relay ship separately, so an incompatible change under the same name
  fails in silence. Either negotiate the new name beside the old one on the
  same path, as v3 does beside v2, or bump the path and make the gateway
  refuse the old one with `426`.
- **v3 allows stream id 0 for `ACK` only.** Read v3 with `decodeFrameV3`.
  `decodeFrame` reads v2 and refuses an `ACK`.
- **A side never drops a frame on a bad count.** An `ACK` or a resume count
  above the sent count, or below the last count acknowledged, is a protocol
  error. `ReplayLog` enforces this.

## Checks

```bash
pnpm run formatcheck && pnpm run typecheck && pnpm run lint && pnpm run test
```

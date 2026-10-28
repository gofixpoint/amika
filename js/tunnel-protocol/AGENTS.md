# @amika/tunnel-protocol

`amika.tunnel.v2`: the frames amika-hostd and Amika's per-host relay
exchange over a host's tunnel WebSocket.

| Entry point                     | What it holds                                         |
| ------------------------------- | ----------------------------------------------------- |
| `@amika/tunnel-protocol`        | The codec, the head schemas and every shared constant |
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
- **A change to the wire format is a new subprotocol.** Bump
  `TUNNEL_SUBPROTOCOL` and the path, and make the gateway refuse the old one
  with `426`. Hosts and the relay ship separately, so an incompatible change
  under the same name fails in silence.

## Checks

```bash
pnpm run formatcheck && pnpm run typecheck && pnpm run lint && pnpm run test
```

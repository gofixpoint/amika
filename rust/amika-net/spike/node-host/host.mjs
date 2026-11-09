// Test 8: the amika-net host role on the Node binding (@number0/iroh 1.2.0).
// Same ALPN and stream header as the Rust host, so the Rust `connect` role
// can dial it. Access check: the caller id must be in ALLOWED (checked after
// accept, because the binding has no handshake hook).
//
// Usage: node host.mjs <key-file> <allowed-ids-file>
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import net from "node:net";
import { Endpoint, presetN0, EndpointId } from "@number0/iroh";

const ALPN = Array.from(Buffer.from("amika/net/1"));
const TARGETS = { "rig:test:22": ["127.0.0.1", 22] };
const [keyFile, allowedFile] = process.argv.slice(2);

if (!existsSync(keyFile)) writeFileSync(keyFile, randomBytes(32).toString("hex") + "\n", { mode: 0o600 });
const secret = Array.from(Buffer.from(readFileSync(keyFile, "utf8").trim(), "hex"));
const allowed = new Set(readFileSync(allowedFile, "utf8").split(/\s+/).filter(Boolean));

const b = Endpoint.builder();
presetN0(b);
b.secretKey(secret);
b.alpns([ALPN]);
const ep = await b.bind();
await ep.online();
console.error(`endpoint online id=${ep.id().toString()}`);

for (;;) {
  const incoming = await ep.acceptNext();
  if (!incoming) break;
  serve(incoming).catch((e) => console.error(`connection error: ${e.message}`));
}

async function serve(incoming) {
  const accepting = await incoming.accept();
  const conn = await accepting.connect();
  const caller = conn.remoteId().toString();
  if (!allowed.has(caller)) {
    conn.close(403n, Array.from(Buffer.from("caller not allowed")));
    console.error(`rejected caller=${caller}`);
    return;
  }
  console.error(`accepted caller=${caller}`);
  for (;;) {
    let bi;
    try {
      bi = await conn.acceptBi();
    } catch {
      return;
    }
    serveStream(bi.send, bi.recv).catch((e) => console.error(`stream error: ${e.message}`));
  }
}

async function serveStream(send, recv) {
  const len = Buffer.from(await recv.readExact(2)).readUInt16BE(0);
  const header = Buffer.from(await recv.readExact(len)).toString("utf8");
  const target = /^target (.+)$/m.exec(header)?.[1];
  const dest = TARGETS[target];
  if (!dest) return writeStatus(send, `error unknown-rig: ${target}`).then(() => send.finish());
  const sock = net.connect(dest[1], dest[0]);
  await new Promise((ok, fail) => sock.once("connect", ok).once("error", fail));
  sock.setNoDelay(true);
  await writeStatus(send, "ok");
  // TCP -> QUIC
  sock.on("data", (chunk) => {
    sock.pause();
    send.writeAll(Array.from(chunk)).then(() => sock.resume(), () => sock.destroy());
  });
  sock.on("end", () => send.finish().catch(() => {}));
  // QUIC -> TCP
  for (;;) {
    let chunk;
    try {
      chunk = await recv.read(65536);
    } catch {
      break;
    }
    if (!chunk || chunk.length === 0) break;
    if (!sock.write(Buffer.from(chunk))) await new Promise((r) => sock.once("drain", r));
  }
  sock.end();
}

async function writeStatus(send, text) {
  const body = Buffer.from(text);
  const frame = Buffer.alloc(2 + body.length);
  frame.writeUInt16BE(body.length, 0);
  body.copy(frame, 2);
  await send.writeAll(Array.from(frame));
}

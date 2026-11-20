/**
 * Reading a guest's answer to an upgrade handshake, which hostd relays as
 * bytes (`services.ts`): its status, and, for an answer that refuses the
 * upgrade, where its body ends.
 *
 * Each head here is raw: the status line and header lines, without the
 * blank line that ends them, as `finishUpgrade` in
 * `@amika/service-auth/gateway` takes and returns it.
 */

/** The status code a head's status line gives, or null for no status line. */
export function answerStatus(head: string): number | null {
  const match = /^HTTP\/\d\.\d (\d{3})(?: |$)/.exec(head);
  return match ? Number(match[1]) : null;
}

/**
 * A refusal's head as the caller gets it: told the connection closes after
 * it, in place of any `Connection` or `Keep-Alive` the guest sent for its
 * own connection to hostd.
 */
export function closingHead(head: string): string {
  const [status, ...fields] = headFields(head);
  const kept = fields.filter((lines) => {
    const name = fieldName(lines);
    return name !== "connection" && name !== "keep-alive";
  });
  return [status, ...kept, ["Connection: close"]].flat().join("\r\n");
}

/** Where a refusal's body ends, fed the bytes after its head in order. */
export interface AnswerBody {
  /** Whether only the guest's closing its connection ends the body. */
  readonly untilClose: boolean;
  /**
   * How many of `bytes`, from the start, are body, and whether they finish
   * it. Null for a malformed chunked body.
   */
  take(bytes: Buffer): { length: number; done: boolean } | null;
}

/**
 * How the body of the answer `head` gives to a `method` request ends
 * (RFC 9112 §6.3), or null where the answer's framing is invalid.
 */
export function answerBody(head: string, method: string): AnswerBody | null {
  const status = answerStatus(head);
  if (status === null) return null;
  if (method === "HEAD" || status < 200 || status === 204 || status === 304) {
    return lengthBody(0);
  }
  const fields = headFields(head).slice(1);
  const codings = fields
    .filter((lines) => fieldName(lines) === "transfer-encoding")
    .flatMap((lines) => fieldValue(lines).split(","))
    .map((coding) => coding.trim().toLowerCase())
    .filter(Boolean);
  if (codings.length > 0) {
    return codings.at(-1) === "chunked" ? chunkedBody() : untilCloseBody();
  }
  const lengths = new Set(
    fields
      .filter((lines) => fieldName(lines) === "content-length")
      .flatMap((lines) => fieldValue(lines).split(","))
      .map((length) => length.trim()),
  );
  if (lengths.size === 0) return untilCloseBody();
  const [length] = lengths;
  if (lengths.size > 1 || !/^\d{1,15}$/.test(length)) return null;
  return lengthBody(Number(length));
}

/** The longest chunk-size or trailer line hostd reads. */
const MAX_CHUNK_LINE = 64 * 1024;

function lengthBody(length: number): AnswerBody {
  let remaining = length;
  return {
    untilClose: false,
    take(bytes) {
      const taken = Math.min(remaining, bytes.length);
      remaining -= taken;
      return { length: taken, done: remaining === 0 };
    },
  };
}

function untilCloseBody(): AnswerBody {
  return {
    untilClose: true,
    take: (bytes) => ({ length: bytes.length, done: false }),
  };
}

/**
 * A chunked body (RFC 9112 §7.1): chunks, each a size line, that many
 * bytes and a CRLF; then a zero-size chunk, trailer lines and a blank line.
 */
function chunkedBody(): AnswerBody {
  let state: "size" | "data" | "data-end" | "trailer" = "size";
  /** Bytes of the current chunk's data not yet taken. */
  let remaining = 0;
  /** The line being read, so far. */
  let line = "";
  return {
    untilClose: false,
    take(bytes) {
      let at = 0;
      while (at < bytes.length) {
        if (state === "data") {
          const taken = Math.min(remaining, bytes.length - at);
          at += taken;
          remaining -= taken;
          if (remaining === 0) state = "data-end";
          continue;
        }
        const lf = bytes.indexOf(0x0a, at);
        line += bytes.toString("latin1", at, lf < 0 ? bytes.length : lf);
        if (line.length > MAX_CHUNK_LINE) return null;
        if (lf < 0) return { length: bytes.length, done: false };
        at = lf + 1;
        const text = line.endsWith("\r") ? line.slice(0, -1) : line;
        line = "";
        if (state === "size") {
          const size = /^([0-9a-fA-F]{1,12})[ \t]*(?:;.*)?$/.exec(text);
          if (!size) return null;
          remaining = Number.parseInt(size[1], 16);
          state = remaining === 0 ? "trailer" : "data";
        } else if (state === "data-end") {
          if (text !== "") return null;
          state = "size";
        } else if (text === "") {
          return { length: at, done: true };
        }
      }
      return { length: at, done: false };
    },
  };
}

/**
 * A head's lines grouped by field: the status line first, then each header
 * line with any folded lines that continue it.
 */
function headFields(head: string): string[][] {
  const fields: string[][] = [];
  for (const line of head.split("\r\n")) {
    const last = fields.at(-1);
    if (last && fields.length > 1 && /^[ \t]/.test(line)) last.push(line);
    else fields.push([line]);
  }
  return fields;
}

/** A field's name, lowercased. */
function fieldName([first]: string[]): string {
  const colon = first.indexOf(":");
  return colon < 0 ? "" : first.slice(0, colon).trim().toLowerCase();
}

/** A field's value, folded lines joined. */
function fieldValue([first, ...folded]: string[]): string {
  return [first.slice(first.indexOf(":") + 1), ...folded].join(" ").trim();
}

import type { Side } from "../types.js";
import type { ReviewLocation } from "./types.js";

/**
 * Serialize a ReviewLocation as a URL query string (no leading `?`).
 * `{ kind: "none" }` produces an empty string.
 */
export function locationToSearch(loc: ReviewLocation): string {
  const params = new URLSearchParams();
  switch (loc.kind) {
    case "none":
      return "";
    case "comment":
      params.set("comment", loc.commentId);
      break;
    case "item":
      params.set("item", loc.itemId);
      break;
    case "file":
      params.set("item", loc.itemId);
      params.set("file", loc.path);
      break;
    case "line":
      params.set("item", loc.itemId);
      params.set("file", loc.path);
      params.set("line", String(loc.line));
      if (loc.side) params.set("side", loc.side);
      break;
  }
  return params.toString();
}

/**
 * Parse a URL query string (with or without the leading `?`) back into a
 * ReviewLocation. Malformed inputs degrade gracefully to coarser kinds or
 * to `{ kind: "none" }`.
 */
export function locationFromSearch(search: string): ReviewLocation {
  const params = new URLSearchParams(
    search.startsWith("?") ? search.slice(1) : search,
  );

  const commentId = params.get("comment");
  if (commentId) return { kind: "comment", commentId };

  const itemId = params.get("item");
  if (!itemId) return { kind: "none" };

  const path = params.get("file");
  if (!path) return { kind: "item", itemId };

  const lineRaw = params.get("line");
  if (lineRaw === null) return { kind: "file", itemId, path };

  const line = Number(lineRaw);
  if (!Number.isFinite(line)) return { kind: "file", itemId, path };

  const sideRaw = params.get("side");
  const side: Side | undefined =
    sideRaw === "old" || sideRaw === "new" ? sideRaw : undefined;

  return { kind: "line", itemId, path, line, side };
}

import { parsePatch, parsePatches } from "./parser.js";
import type { ReviewItem } from "./types.js";

/**
 * Read each File as text and parse as a patch. Use when the caller has File
 * objects from an upload input or drag-and-drop event.
 */
export async function loadFromFiles(files: File[]): Promise<ReviewItem[]> {
  const texts = await Promise.all(files.map((f) => f.text()));
  return parsePatches(texts);
}

/**
 * Parse one or more patch strings without going through a File object.
 * Use when the caller already has the raw `.diff` / `.patch` text (server
 * response, embedded asset, etc).
 */
export function loadFromText(input: string | string[]): ReviewItem[] {
  if (Array.isArray(input)) return parsePatches(input);
  return [parsePatch(input)];
}

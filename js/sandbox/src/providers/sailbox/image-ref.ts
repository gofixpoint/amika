import type { ImageSpec } from "@sailresearch/sdk";

const SAILBOX_IMAGE_PREFIX = "sail-image:";

/** Encode an SDK image spec into the config-safe value stored per preset. */
export function encodeSailboxImageRef(image: ImageSpec): string {
  return (
    SAILBOX_IMAGE_PREFIX +
    Buffer.from(JSON.stringify(image)).toString("base64url")
  );
}

/** Decode a preset image reference; non-image values are checkpoint ids. */
export function decodeSailboxImageRef(value: string): ImageSpec | null {
  if (!value.startsWith(SAILBOX_IMAGE_PREFIX)) return null;
  const encoded = value.slice(SAILBOX_IMAGE_PREFIX.length);
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch (cause) {
    throw new Error("Invalid Sailbox image reference", { cause });
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Invalid Sailbox image reference: expected an object");
  }
  return parsed as ImageSpec;
}

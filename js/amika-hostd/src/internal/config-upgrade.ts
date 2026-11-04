/**
 * Rewrite an old `config.toml` in the current format. `amika-hostd config
 * upgrade` and `setup` run it, and the installer runs the command on an
 * upgrade, so a host keeps working after hostd stops reading the old tables.
 */
import { parse as parseToml } from "smol-toml";
import { ConfigError, type HostdConfigFile } from "./config.js";

/**
 * `contents` with its `[preset_images]` table replaced, in place, by one
 * `[presets.<name>.runtimes.smol]` table for each entry. Control planes named
 * presets `amika-<preset>`, and the new tables use Amika's names, so the
 * prefix goes. Everything else in the file stays as the operator wrote it.
 */
export function upgradeConfig(contents: string): {
  contents: string;
  upgraded: boolean;
} {
  let raw: Record<string, unknown>;
  try {
    raw = parseToml(contents);
  } catch {
    // `resolveConfig` reports the file as not valid TOML, without its text.
    return { contents, upgraded: false };
  }
  const images = raw.preset_images;
  if (images === undefined) return { contents, upgraded: false };
  if (!isStringTable(images)) {
    throw new ConfigError(
      "[preset_images] is not a table of image references; edit it by hand",
    );
  }
  const presets = isTable(raw.presets) ? raw.presets : {};
  const tables = Object.entries(images).flatMap(([name, image]) => {
    const preset = name.startsWith("amika-")
      ? name.slice("amika-".length)
      : name;
    if (Object.hasOwn(presets, preset)) {
      throw new ConfigError(
        `[preset_images] and [presets.${preset}] both set preset ${preset}; remove one`,
      );
    }
    return [
      `[presets.${tomlKey(preset)}.runtimes.smol]`,
      `image = ${JSON.stringify(image)}`,
      "",
    ];
  });

  const lines = contents.split("\n");
  const start = lines.findIndex((line) =>
    /^\s*\[\s*preset_images\s*\]\s*(#.*)?$/.test(line),
  );
  if (start === -1) {
    // An inline table (`preset_images = { ... }`), which setup never writes.
    throw new ConfigError(
      "preset_images is not a [preset_images] table; edit it by hand",
    );
  }
  let end = start + 1;
  while (end < lines.length && !/^\s*\[/.test(lines[end])) end++;
  // Keep the comments and blank lines that lead into the next table.
  while (end > start + 1 && /^\s*(#.*)?$/.test(lines[end - 1])) end--;
  lines.splice(start, end - start, ...tables.slice(0, -1));
  return { contents: lines.join("\n"), upgraded: true };
}

/** `file`, upgraded; the same object when there is nothing to upgrade. */
export function upgradeConfigFile(file: HostdConfigFile): HostdConfigFile {
  const { contents, upgraded } = upgradeConfig(file.contents);
  return upgraded ? { ...file, contents } : file;
}

/** A name as a TOML key: bare when TOML allows it, else quoted. */
export function tomlKey(name: string): string {
  return /^[A-Za-z0-9_-]+$/.test(name) ? name : JSON.stringify(name);
}

function isTable(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringTable(value: unknown): value is Record<string, string> {
  return (
    isTable(value) && Object.values(value).every((v) => typeof v === "string")
  );
}

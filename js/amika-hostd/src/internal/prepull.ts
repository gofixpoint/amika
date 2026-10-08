/**
 * Pull this host's preset images into smolvm's image cache once, in the
 * background, so the first rig of each image does not wait for its download.
 *
 * smolvm keeps a pulled registry image as a shared, read-only "seed" that
 * every later machine of that image starts from copy-on-write, keyed by the
 * digest the reference points to. It builds a seed the first time a machine
 * of the image is created, and on each `smolvm serve` start it refreshes the
 * seeds of images machines used in the last week. So hostd only has to start
 * the cache: for each configured image it has not pulled before, it creates a
 * throwaway machine (which builds the seed) and deletes it, and records the
 * image in `prepull.json` so a later `up` does not repeat it.
 */
import { readFileSync } from "node:fs";
import { z } from "zod";
import type { MachineRuntime } from "./machine-runtime.js";
import { writePrivateFile } from "./private-file.js";

/** Names the throwaway machines, so a run cut short can clean them up. */
export const PREPULL_MACHINE_PREFIX = "amika-hostd-prepull-";

/**
 * smolvm seeds only machines whose storage disk is at least its 20 GiB
 * template (`DEFAULT_STORAGE_SIZE_GIB`): a rig asking for less starts on a
 * shrunken template disk instead, and pulls its image inside the VM every
 * time.
 */
export const SMOLVM_SEED_MIN_DISK_GIB = 20;

/**
 * How long one pre-pull may take. A create builds the seed before it
 * answers, so it lasts the whole download of an image of several GB.
 */
export const PREPULL_TIMEOUT_MS = 60 * 60 * 1000;

/** An image reference to pull, with the presets configured to boot it. */
export interface PendingImage {
  image: string;
  presets: string[];
}

const stateSchema = z.object({ images: z.array(z.string()) });

/** The image references pulled so far; a missing or unreadable file is none. */
export function pulledImages(stateFile: string): Set<string> {
  try {
    return new Set(
      stateSchema.parse(JSON.parse(readFileSync(stateFile, "utf8"))).images,
    );
  } catch {
    return new Set();
  }
}

/**
 * The configured images not pulled yet, each reference once, in config
 * order. Several presets may share a reference.
 */
export function pendingImages(
  images: Record<string, string>,
  stateFile: string,
): PendingImage[] {
  const pulled = pulledImages(stateFile);
  const pending = new Map<string, string[]>();
  for (const [preset, image] of Object.entries(images)) {
    if (pulled.has(image)) continue;
    pending.set(image, [...(pending.get(image) ?? []), preset]);
  }
  return [...pending].map(([image, presets]) => ({ image, presets }));
}

function recordPulled(stateFile: string, image: string) {
  const images = [...pulledImages(stateFile), image];
  writePrivateFile(
    stateFile,
    `${JSON.stringify({ images: [...new Set(images)] }, null, 2)}\n`,
  );
}

export interface PrepullOptions {
  images: Record<string, string>;
  stateFile: string;
  /** Runs the throwaway machines; give it `PREPULL_TIMEOUT_MS`. */
  runtime: MachineRuntime;
  out: (line: string) => void;
  err: (line: string) => void;
  /** Stops before the next image once this aborts (the daemon is stopping). */
  signal?: AbortSignal;
  now?: () => number;
}

/**
 * Pull each configured image not pulled before, one at a time, first
 * deleting any throwaway machine a run cut short left behind. Never throws:
 * a failed pull is logged and left unrecorded, so the next `up` tries it
 * again, and until then a rig of that image pulls it inside its own VM.
 */
export async function prepullImages({
  images,
  stateFile,
  runtime,
  out,
  err,
  signal,
  now = Date.now,
}: PrepullOptions): Promise<void> {
  const remove = async (name: string) => {
    try {
      await runtime.remove(name);
    } catch (error) {
      err(
        `amika-hostd: could not delete pre-pull machine ${name}: ${reason(error)}`,
      );
    }
  };
  try {
    for (const machine of await runtime.list()) {
      if (machine.name.startsWith(PREPULL_MACHINE_PREFIX)) {
        await remove(machine.name);
      }
    }
  } catch (error) {
    err(
      `amika-hostd: could not list machines before pre-pulling: ${reason(error)}`,
    );
  }
  const pending = pendingImages(images, stateFile);
  for (const [index, { image, presets }] of pending.entries()) {
    if (signal?.aborted) return;
    const name = `${PREPULL_MACHINE_PREFIX}${index}`;
    const started = now();
    out(`Pre-pulling ${image} (${presets.join(", ")})`);
    try {
      // A disk smolvm seeds, so this create builds the image's seed.
      await runtime.create({
        name,
        image,
        network: true,
        storageGb: SMOLVM_SEED_MIN_DISK_GIB,
      });
    } catch (error) {
      err(
        `amika-hostd: could not pre-pull ${image}: ${reason(error)}; rigs of it pull it themselves, and the next \`amika-hostd up\` tries again`,
      );
      // A create that failed after making the machine leaves it behind.
      if (!signal?.aborted) await remove(name);
      continue;
    }
    await remove(name);
    try {
      recordPulled(stateFile, image);
    } catch (error) {
      err(
        `amika-hostd: could not record the pre-pull of ${image} in ${stateFile}: ${reason(error)}; the next \`amika-hostd up\` pulls it again`,
      );
    }
    out(
      `Pre-pulled ${image} in ${Math.round((now() - started) / 1000)}s; new rigs of it start from smolvm's image cache`,
    );
  }
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

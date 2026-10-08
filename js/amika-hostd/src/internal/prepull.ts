/**
 * Keep this host's preset images in smolvm's image cache, in the background,
 * so no rig waits for its image to download.
 *
 * smolvm keeps a pulled registry image as a shared, read-only "seed" that
 * every later machine of that image starts from copy-on-write, keyed by the
 * digest the reference points to. A create attaches the seed, building it
 * first when it is missing (a new image, a moved tag, or one smolvm evicted
 * or lost), without booting the machine. So on every start the daemon
 * creates and deletes one unstarted throwaway machine per configured image:
 * a cached image costs one registry request to resolve its digest, and only
 * a missing one is downloaded. `prepull.json` records the images pulled
 * before, so `up` can say when a download is coming.
 */
import { readFileSync } from "node:fs";
import { z } from "zod";
import type { ProviderRuntime } from "./machine-runtime.js";
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
 * How long one pre-pull may take. A create builds a missing seed before it
 * answers, so it can last the whole download of an image of several GB.
 */
export const PREPULL_TIMEOUT_MS = 60 * 60 * 1000;

/** An image reference, with the presets configured to boot it. */
export interface ConfiguredImage {
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
 * Each configured reference once, in config order, with its presets.
 * Several presets may share a reference.
 */
function configuredImages(images: Record<string, string>): ConfiguredImage[] {
  const byImage = new Map<string, string[]>();
  for (const [preset, image] of Object.entries(images)) {
    byImage.set(image, [...(byImage.get(image) ?? []), preset]);
  }
  return [...byImage].map(([image, presets]) => ({ image, presets }));
}

/** The configured images never pulled before: those `up` announces. */
export function pendingImages(
  images: Record<string, string>,
  stateFile: string,
): ConfiguredImage[] {
  const pulled = pulledImages(stateFile);
  return configuredImages(images).filter(({ image }) => !pulled.has(image));
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
  runtime: Pick<ProviderRuntime, "list" | "remove" | "createUnstarted">;
  out: (line: string) => void;
  err: (line: string) => void;
  /** Stops before the next image once this aborts (the daemon is stopping). */
  signal?: AbortSignal;
  now?: () => number;
}

/**
 * Make sure each configured image is cached, one at a time, first deleting
 * any throwaway machine a run cut short left behind. Never throws: a failed
 * check is logged and tried again on the next start, and until then a rig of
 * that image pulls it inside its own VM if its seed is missing.
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
  for (const [index, { image, presets }] of configuredImages(
    images,
  ).entries()) {
    if (signal?.aborted) return;
    const name = `${PREPULL_MACHINE_PREFIX}${index}`;
    const started = now();
    out(`Checking that ${image} (${presets.join(", ")}) is cached`);
    try {
      // A disk smolvm seeds, so this create attaches the image's seed, and
      // builds it first if it is missing.
      await runtime.createUnstarted({
        name,
        image,
        storageGb: SMOLVM_SEED_MIN_DISK_GIB,
      });
    } catch (error) {
      err(
        `amika-hostd: could not cache ${image}: ${reason(error)}; rigs of it may pull it themselves, and the next \`amika-hostd up\` tries again`,
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
      `${image} is cached (${Math.round((now() - started) / 1000)}s); new rigs of it start from smolvm's image cache`,
    );
  }
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

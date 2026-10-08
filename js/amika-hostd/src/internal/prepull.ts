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
import { RuntimeError, type ProviderRuntime } from "./machine-runtime.js";
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

/**
 * `prepull.json`: the images pulled before, which only decide what `up`
 * announces, and the throwaway machines hostd created and has not yet
 * deleted. Only machines named here are ever deleted or hidden as hostd's:
 * a rig that merely shares the prefix (one created before the prefix was
 * reserved) is left alone.
 */
const stateSchema = z.object({
  images: z.array(z.string()),
  machines: z.array(z.string()).optional(),
});

type PrepullState = Required<z.infer<typeof stateSchema>>;

/** The state file's contents; a missing or unreadable file is empty. */
function readState(stateFile: string): PrepullState {
  try {
    const state = stateSchema.parse(
      JSON.parse(readFileSync(stateFile, "utf8")),
    );
    return { images: state.images, machines: state.machines ?? [] };
  } catch {
    return { images: [], machines: [] };
  }
}

function updateState(
  stateFile: string,
  change: (state: PrepullState) => PrepullState,
) {
  const next = change(readState(stateFile));
  writePrivateFile(
    stateFile,
    `${JSON.stringify(
      {
        images: [...new Set(next.images)],
        machines: [...new Set(next.machines)],
      },
      null,
      2,
    )}\n`,
  );
}

/** The image references pulled so far. */
export function pulledImages(stateFile: string): Set<string> {
  return new Set(readState(stateFile).images);
}

/** The throwaway machines hostd created and has not deleted yet. */
export function prepullMachines(stateFile: string): Set<string> {
  return new Set(readState(stateFile).machines);
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
 * the throwaway machines a run cut short left behind. Never throws: a failed
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
  const forget = (name: string) => {
    try {
      updateState(stateFile, (state) => ({
        ...state,
        machines: state.machines.filter((machine) => machine !== name),
      }));
    } catch (error) {
      err(`amika-hostd: could not update ${stateFile}: ${errorMessage(error)}`);
    }
  };
  /**
   * Delete a machine hostd created, and forget it once it is gone. Returns
   * whether it is gone; one that is not stays recorded, to try again.
   */
  const remove = async (name: string): Promise<boolean> => {
    try {
      await runtime.remove(name);
    } catch (error) {
      if (!(error instanceof RuntimeError && error.status === 404)) {
        err(
          `amika-hostd: could not delete pre-pull machine ${name}: ${errorMessage(error)}; the next \`amika-hostd up\` tries again`,
        );
        return false;
      }
    }
    forget(name);
    return true;
  };
  // Every machine's name, so a throwaway one never takes a rig's.
  let taken: Set<string>;
  try {
    taken = new Set((await runtime.list()).map((machine) => machine.name));
  } catch (error) {
    err(
      `amika-hostd: could not list machines, so no image is pre-pulled: ${errorMessage(error)}`,
    );
    return;
  }
  for (const name of prepullMachines(stateFile)) {
    // A machine that could not be deleted still holds its name.
    if (await remove(name)) taken.delete(name);
  }
  let next = 0;
  const freeName = () => {
    while (taken.has(`${PREPULL_MACHINE_PREFIX}${next}`)) next++;
    return `${PREPULL_MACHINE_PREFIX}${next++}`;
  };
  for (const { image, presets } of configuredImages(images)) {
    if (signal?.aborted) return;
    const name = freeName();
    const started = now();
    out(`Checking that ${image} (${presets.join(", ")}) is cached`);
    // Recorded first, so a run cut short leaves a machine the next one
    // knows to delete; one hostd cannot record, it never creates.
    try {
      updateState(stateFile, (state) => ({
        ...state,
        machines: [...state.machines, name],
      }));
    } catch (error) {
      err(
        `amika-hostd: could not cache ${image}: cannot update ${stateFile}: ${errorMessage(error)}`,
      );
      continue;
    }
    try {
      // A disk smolvm seeds, so this create attaches the image's seed, and
      // builds it first if it is missing.
      await runtime.createUnstarted({
        name,
        image,
        storageGb: SMOLVM_SEED_MIN_DISK_GIB,
      });
    } catch (error) {
      // The daemon stopping cuts the request short; that is no failure, and
      // the next start deletes the machine it recorded.
      if (signal?.aborted) return;
      err(
        `amika-hostd: could not cache ${image}: ${errorMessage(error)}; rigs of it may pull it themselves, and the next \`amika-hostd up\` tries again`,
      );
      if (error instanceof RuntimeError && error.status === 409) {
        // Someone else's machine took the name first: never delete it.
        taken.add(name);
        forget(name);
      } else {
        // A create that failed after making the machine leaves it behind.
        await remove(name);
      }
      continue;
    }
    await remove(name);
    try {
      updateState(stateFile, (state) => ({
        ...state,
        images: [...state.images, image],
      }));
    } catch (error) {
      err(
        `amika-hostd: could not record the pre-pull of ${image} in ${stateFile}: ${errorMessage(error)}; the next \`amika-hostd up\` announces it again`,
      );
    }
    // smolvm logs, but does not report, a seed it could not build, so this
    // is as far as hostd can tell.
    out(
      `Checked ${image} (${Math.round((now() - started) / 1000)}s); if its rigs still download it, see smolvm.log`,
    );
  }
}

/** An error's message, for a log line. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

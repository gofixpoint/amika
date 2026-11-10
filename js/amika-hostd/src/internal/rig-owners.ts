/**
 * Who owns each rig, for check 2 of the iroh transport (spec 035,
 * `iroh-contracts.md`, "Rig owners").
 *
 * The control plane names the owner in the create request (`owner`), and
 * hostd records it with the rig. The rules give a role `own` rigs or `all`
 * rigs; a rig with no owner matches only `all`. The file store keeps the
 * owners across daemon restarts, written whole and atomically on each
 * change.
 */
import { readFileSync } from "node:fs";
import { z } from "zod";
import type { Principal } from "@amika/iroh-rules";
import { writePrivateFile } from "./private-file.js";

export interface RigOwners {
  /** The rig's owner, or null when it was created without one. */
  get(rig: string): Principal | null;
  /** Record a rig's owner, replacing any an earlier rig of its name left. */
  set(rig: string, owner: Principal | undefined): void;
  remove(rig: string): void;
}

/** Owners kept in `file`, created with private permissions. */
export function fileRigOwners(file: string): RigOwners {
  const owners = load(file);
  return ownersOver(owners, () =>
    writePrivateFile(file, `${JSON.stringify(Object.fromEntries(owners))}\n`),
  );
}

/** Owners that are forgotten on restart, for tests and `createApp`. */
export function memoryRigOwners(): RigOwners {
  return ownersOver(new Map(), () => {});
}

function ownersOver(
  owners: Map<string, Principal>,
  save: () => void,
): RigOwners {
  return {
    get: (rig) => owners.get(rig) ?? null,
    set: (rig, owner) => {
      if (owner === undefined) {
        if (owners.delete(rig)) save();
        return;
      }
      owners.set(rig, { kind: owner.kind, id: owner.id });
      save();
    },
    remove: (rig) => {
      if (owners.delete(rig)) save();
    },
  };
}

/** The principal kinds a host knows. It refuses any other. */
export const ownerSchema = z.strictObject({
  kind: z.literal("user"),
  id: z.string().min(1).max(200),
});

const fileSchema = z.record(z.string(), ownerSchema);

/** An absent file holds no owners; an unreadable one is an error. */
function load(file: string): Map<string, Principal> {
  let contents: string;
  try {
    contents = readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Map();
    throw error;
  }
  return new Map(Object.entries(fileSchema.parse(JSON.parse(contents))));
}

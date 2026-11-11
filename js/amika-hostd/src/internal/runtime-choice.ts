/**
 * Which runtimes a host runs: asked by `amika-hostd setup` and by
 * `capabilities update` run in a terminal, or given as `--enable` and
 * `--disable`. Only the runtimes this machine can run are offered, and each
 * defaults to what the config already says, so on a new host only smol is
 * on, and answering nothing changes nothing.
 */
import { ConfigError } from "./config.js";
import { MACOS_IMAGE_COST } from "./lume-setup.js";
import type { RuntimeChange } from "./runtime-update.js";
import { RUNTIME_NAMES, type RuntimeName } from "./runtimes.js";

/** What each runtime is, as setup asks about it. */
export const RUNTIME_QUESTIONS: Record<RuntimeName, string> = {
  smol: "Run Linux rigs, in VMs with smolvm?",
  lume: `Run macOS rigs, in VMs with Lume? This installs Lume and builds a macOS image on this Mac. ${MACOS_IMAGE_COST}`,
  bare_metal:
    "Make this machine itself a rig (bare_metal)? Amika gets SSH to it as your own account, with no VM in between.",
};

/** Asks a yes/no question; `current` is the answer an empty reply gives. */
export type AskYesNo = (question: string, current: boolean) => Promise<boolean>;

/**
 * The change to the runtimes that are `on`: each runtime `given` names is
 * set as given, and each other one this machine can run is asked about
 * through `ask` (or kept as it is without `ask`). A runtime this machine
 * cannot run is never asked about; turning one on, or leaving one on that
 * is not `given` as disabled, is refused. Leaving no runtime on is refused.
 */
export async function chooseRuntimes(
  supported: readonly RuntimeName[],
  on: ReadonlySet<RuntimeName>,
  ask: AskYesNo | undefined,
  given: RuntimeChange = { enable: [], disable: [] },
): Promise<RuntimeChange> {
  const unsupported = given.enable.find((name) => !supported.includes(name));
  if (unsupported !== undefined) {
    throw new ConfigError(
      `This machine cannot run ${unsupported}; it can run ${supported.join(", ") || "none"}. Nothing was changed.`,
    );
  }
  const next = new Set(on);
  for (const name of RUNTIME_NAMES) {
    if (given.enable.includes(name)) next.add(name);
    else if (given.disable.includes(name)) next.delete(name);
    else if (ask && supported.includes(name)) {
      if (await ask(RUNTIME_QUESTIONS[name], on.has(name))) next.add(name);
      else next.delete(name);
    }
  }
  // A config copied from another machine (Lume from an Apple Silicon Mac,
  // say) can have one on that this machine cannot run, which is never asked
  // about. Refused here, before anything is installed for it.
  const stranded = RUNTIME_NAMES.find(
    (name) => next.has(name) && !supported.includes(name),
  );
  if (stranded !== undefined) {
    throw new ConfigError(
      `The config turns on ${stranded}, which this machine cannot run${stranded === "lume" ? " (it needs macOS on Apple Silicon)" : ""}. Pass --disable ${stranded}, or turn it off in [runtimes.${stranded}]. Nothing was changed.`,
    );
  }
  if (next.size === 0) {
    throw new ConfigError(
      "A host needs at least one runtime on; nothing was changed.",
    );
  }
  return {
    enable: RUNTIME_NAMES.filter((name) => next.has(name) && !on.has(name)),
    disable: RUNTIME_NAMES.filter((name) => !next.has(name) && on.has(name)),
  };
}

/**
 * `ask` for a prompt: `[Y/n]` or `[y/N]` after the question, by the current
 * answer, which an empty reply or end of input keeps. Any other reply asks
 * again.
 */
export function askYesNo(
  prompt: (question: string) => Promise<string | undefined>,
): AskYesNo {
  return async (question, current) => {
    for (;;) {
      const answer = (
        await prompt(`${question} ${current ? "[Y/n]" : "[y/N]"} `)
      )
        ?.trim()
        .toLowerCase();
      if (answer === undefined || answer === "") return current;
      if (answer === "y" || answer === "yes") return true;
      if (answer === "n" || answer === "no") return false;
    }
  };
}

/**
 * `amika-hostd uninstall`: remove what hostd's runtimes put on this machine,
 * after `down` has stopped the daemon. `install-amika-hostd.sh --uninstall`
 * runs it, then removes amika-hostd itself, its config, state and secrets.
 *
 * - Lume rigs and `storage_dir`: deleted, after a yes (or `--yes`).
 * - The macOS base VM and templates in Lume's own storage: deleted only when
 *   the operator types a phrase, since a rebuild takes half an hour.
 * - smolvm in `~/.smolvm`: deleted only when the operator types a phrase,
 *   since other tools can use it.
 * - Lume itself and a downloaded restore image: never deleted, only named.
 */
import { existsSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import type { HostdConfig } from "./config.js";
import {
  findLume,
  LUME_NO_TELEMETRY,
  MACOS_BASE_VM,
  missingMacosImages,
  runToStderr,
  withoutAmikaSecrets,
} from "./lume-setup.js";
import type { Prompt } from "./prompt.js";
import type { MachineIndex } from "./runtime-router.js";
import { presetImages } from "./runtimes.js";

export interface UninstallDeps {
  env: NodeJS.ProcessEnv;
  out: (line: string) => void;
  /** Absent without a terminal: the typed-phrase questions then keep all. */
  prompt?: Prompt;
  findLume?: typeof findLume;
  missingMacosImages?: typeof missingMacosImages;
  /** Runs a `lume` command; resolves to its exit code. */
  run?: typeof runToStderr;
  remove?: (dir: string) => void;
}

export interface UninstallOptions {
  /** Answer yes to deleting the Lume rigs, never to a typed phrase. */
  yes: boolean;
  dryRun: boolean;
}

/** Remove what the runtimes installed; `config` is undefined without one. */
export async function uninstall(
  config: HostdConfig | undefined,
  machines: MachineIndex,
  options: UninstallOptions,
  deps: UninstallDeps,
): Promise<void> {
  const home = deps.env.HOME || homedir();
  const lume = (deps.findLume ?? findLume)(deps.env);
  const remove =
    deps.remove ?? ((dir) => rmSync(dir, { recursive: true, force: true }));
  const runLume = (args: string[]) =>
    (deps.run ?? runToStderr)(lume ?? "lume", args, {
      ...withoutAmikaSecrets(deps.env),
      ...LUME_NO_TELEMETRY,
    });

  // Lume rigs: hostd's own VMs, in their own storage folder.
  const storageDir = config?.runtimes.runtimes.lume?.storageDir;
  const rigs = machines
    .entries()
    .filter(([, runtime]) => runtime === "lume")
    .map(([name]) => name);
  if (storageDir !== undefined && (rigs.length > 0 || existsSync(storageDir))) {
    const what = `${rigs.length > 0 ? `the Lume rigs ${rigs.join(", ")} and ` : ""}${storageDir}`;
    if (options.dryRun) {
      deps.out(`Would delete ${what}`);
    } else if (await confirm(`Delete ${what}?`, options, deps)) {
      for (const rig of rigs) {
        if (lume === undefined) break;
        await runLume(["stop", rig, "--storage", storageDir, "--force"]);
        await runLume(["delete", rig, "--storage", storageDir, "--force"]);
      }
      if (isSafeToRemove(storageDir, home)) {
        remove(storageDir);
        deps.out(`Deleted ${storageDir}`);
      } else {
        deps.out(`Not deleting ${storageDir}: it is not a folder of its own`);
      }
    }
  }

  // The base VM and templates hostd built, in Lume's default storage.
  if (config !== undefined && lume !== undefined) {
    const built = [
      MACOS_BASE_VM,
      ...Object.values(presetImages(config.runtimes, "lume")),
    ];
    const missing = new Set(
      await (deps.missingMacosImages ?? missingMacosImages)(built, deps),
    );
    const images = [...new Set(built)].filter((name) => !missing.has(name));
    if (images.length > 0) {
      const phrase = "remove macos images";
      if (options.dryRun) {
        deps.out(`Would ask about the Lume VMs ${images.join(", ")}`);
      } else if (
        await typed(
          `The Lume VMs ${images.join(", ")} take about 30 GB, and a rebuild takes 30 minutes or more. Type '${phrase}' to delete them, or press Enter to keep them:`,
          phrase,
          deps,
        )
      ) {
        for (const image of images) await runLume(["delete", image, "--force"]);
        deps.out(`Deleted the Lume VMs ${images.join(", ")}`);
      }
    }
  }

  // smolvm, where its installer put it. Anywhere else is not hostd's.
  const smolvmHome = path.join(home, ".smolvm");
  if (existsSync(path.join(smolvmHome, "smolvm"))) {
    const phrase = "remove smolvm";
    if (options.dryRun) {
      deps.out(`Would ask about smolvm in ${smolvmHome}`);
    } else if (
      await typed(
        `smolvm (${smolvmHome}) may hold VMs and data other tools use. Type '${phrase}' to delete it, or press Enter to keep it:`,
        phrase,
        deps,
      )
    ) {
      remove(path.join(home, ".local", "bin", "smolvm"));
      remove(smolvmHome);
      deps.out(`Deleted ${smolvmHome}`);
    }
  }

  // What hostd never deletes: other tools can use Lume.
  const kept = [
    ...(lume === undefined
      ? []
      : [
          `Lume: ${lume}, ${path.join(home, ".local", "share", "lume")} and ${path.join(home, ".lume")}`,
        ]),
    ...[path.join(deps.env.TMPDIR || tmpdir(), "latest.ipsw")]
      .filter((file) => existsSync(file))
      .map((file) => `macOS restore image: ${file}`),
  ];
  if (kept.length > 0) {
    deps.out("Not deleted, as other tools can use them:");
    for (const line of kept) deps.out(`  ${line}`);
  }
}

/** A yes/no question that `--yes` answers; no terminal and no `--yes` is no. */
async function confirm(
  question: string,
  options: UninstallOptions,
  deps: UninstallDeps,
): Promise<boolean> {
  if (options.yes) return true;
  if (!deps.prompt) return false;
  const answer = await deps.prompt(`${question} [y/N] `);
  return /^y(es)?$/i.test(answer?.trim() ?? "");
}

/** Whether the operator typed `phrase`. No flag answers this. */
async function typed(
  question: string,
  phrase: string,
  deps: UninstallDeps,
): Promise<boolean> {
  if (!deps.prompt) return false;
  return (await deps.prompt(`${question} `))?.trim() === phrase;
}

/** An absolute folder that is not `/` or the home directory. */
function isSafeToRemove(dir: string, home: string): boolean {
  const resolved = path.resolve(dir);
  return (
    path.isAbsolute(dir) &&
    resolved !== path.parse(resolved).root &&
    resolved !== path.resolve(home)
  );
}

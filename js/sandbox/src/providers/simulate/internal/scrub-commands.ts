/** Filesystem effects of the commands emitted by shared/scrub-exec.ts. */
import { shellQuote } from "../../../util/shell";
import type { SandboxExecResult } from "../../provider";

const OK: SandboxExecResult = { exitCode: 0, stdout: "", stderr: "" };

/** Model shared scrub commands; leave other commands to the scripted runtime. */
export function executeScrubCommand(
  files: Map<string, Uint8Array>,
  command: string,
): SandboxExecResult | null {
  // shellQuote uses single quotes and escapes embedded apostrophes as '"'"'.
  const paths = [...command.matchAll(/'((?:[^']|'"'"')*)'/g)].map((match) =>
    match[1].replaceAll(`'"'"'`, "'"),
  );
  const [first, second] = paths;
  if (first === undefined) return null;

  if (command === `rm -rf ${shellQuote(first)}`) {
    for (const path of files.keys()) {
      if (path === first || path.startsWith(`${first.replace(/\/$/, "")}/`)) {
        files.delete(path);
      }
    }
    return OK;
  }
  if (command === `rm -f ${shellQuote(first)}`) {
    files.delete(first);
    return OK;
  }
  if (
    second !== undefined &&
    command === `install -m 0644 ${shellQuote(first)} ${shellQuote(second)}`
  ) {
    const source = files.get(first);
    if (!source) return failure(`Missing scrub baseline: ${first}`);
    files.set(second, new Uint8Array(source));
    return OK;
  }
  if (command === `ls -1d ${paths.map(shellQuote).join(" ")} 2>/dev/null`) {
    return {
      ...OK,
      stdout: paths.filter((path) => exists(files, path)).join("\n"),
    };
  }
  if (
    second !== undefined &&
    command ===
      `source_hash=$(sha256sum ${shellQuote(first)}) && ` +
        `destination_hash=$(sha256sum ${shellQuote(second)}) && ` +
        `[ "\${source_hash%% *}" = "\${destination_hash%% *}" ]`
  ) {
    const source = files.get(first);
    const destination = files.get(second);
    return source && destination && Buffer.from(source).equals(destination)
      ? OK
      : failure("Scrub baseline verification failed");
  }

  const findConfigs = `find ${shellQuote(first)} -type f -path '*/.git/config'`;
  const prefix = `if [ -d ${shellQuote(first)} ]; then ${findConfigs}`;
  const sanitize = `${prefix} -exec sed -i -E 's#https://x-access-token:[^@/]+@#https://#g' {} +; fi`;
  const verify = `${prefix} -exec grep -l 'x-access-token:' {} + 2>/dev/null; fi`;
  if (command === sanitize || command === verify) {
    const leftovers: string[] = [];
    for (const [path, bytes] of files) {
      if (
        !path.startsWith(`${first.replace(/\/$/, "")}/`) ||
        !path.endsWith("/.git/config")
      )
        continue;
      const content = new TextDecoder().decode(bytes);
      if (command === sanitize) {
        files.set(
          path,
          new TextEncoder().encode(
            content.replace(/https:\/\/x-access-token:[^@/]+@/g, "https://"),
          ),
        );
      } else if (content.includes("x-access-token:")) {
        leftovers.push(path);
      }
    }
    return { ...OK, stdout: leftovers.join("\n") };
  }
  return null;
}

function exists(files: Map<string, Uint8Array>, path: string): boolean {
  return (
    files.has(path) ||
    [...files.keys()].some((key) =>
      key.startsWith(`${path.replace(/\/$/, "")}/`),
    )
  );
}

function failure(stderr: string): SandboxExecResult {
  return { exitCode: 1, stdout: "", stderr };
}

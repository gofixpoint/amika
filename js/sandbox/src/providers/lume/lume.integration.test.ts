/**
 * Checks on a real Lume VM that the provider contract does not make
 * (milestone 1 of spec 026). Run on an Apple Silicon Mac with Lume:
 *
 *   TEST_LUME_TEMPLATE=<a stopped template VM in Lume's default storage> \
 *   LUME_STORAGE_DIR=... LUME_STATE_DIR=... \
 *   pnpm --filter @amika/sandbox test:integration src/providers/lume
 *
 * The contract suite itself runs with `TEST_SANDBOX_CONTRACT_PROVIDER=lume`.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { join } from "node:path";
import { sandboxProviderConfigsFromEnv } from "../../config-from-env";
import type { SandboxCtx } from "../../logger";
import { moduleLogger } from "../../logger";
import type { Sandbox } from "../provider";
import lumeProvider from "./provider";
import { GuestSsh } from "./internal/guest-ssh";
import { LumeCli } from "./internal/lume-cli";

const template = process.env.TEST_LUME_TEMPLATE;

describe.skipIf(!template)("lume guest after the SSH bootstrap", () => {
  const config = sandboxProviderConfigsFromEnv({
    ...process.env,
    DAYTONA_API_KEY: "unused",
    LUME_ENABLED: "true",
  }).lume!;
  const provider = lumeProvider(config);
  const ctx: SandboxCtx = {
    logger: moduleLogger({ test: "lume" }),
    childCtx: () => ctx,
  };
  const name = `lume-check-${Date.now()}`;
  let sandbox: Sandbox;

  beforeAll(async () => {
    sandbox = await provider.sandboxes.create(ctx, {
      name,
      snapshot: template!,
      services: [],
    });
  });
  afterAll(async () => {
    await sandbox?.delete();
  });

  it("refuses the bootstrap password", async () => {
    const vm = await new LumeCli(config.storageDir).get(name);
    const result = await new GuestSsh().withPassword(
      {
        ip: vm!.ipAddress!,
        knownHostsFile: join(config.stateDir, "vms", name, "known_hosts"),
      },
      join(config.stateDir, "askpass"),
      "lume",
      "lume",
      "true",
    );
    expect(result.exitCode).toBe(255);
    expect(String(result.stderr)).toMatch(/Permission denied \(publickey\)/);
  });

  it("keeps the management key out of the file amikad owns", async () => {
    const result = await sandbox.exec(
      "test ! -e ~/.ssh/authorized_keys && grep -c ssh-ed25519 /private/var/db/amika/management_authorized_keys",
    );
    expect(result).toMatchObject({ exitCode: 0, stdout: "1\n" });
  });

  it("gives written files to the amika user, also under a root-owned folder", async () => {
    const home = `${provider.userHomeDir}/owned.txt`;
    const system = "/usr/local/etc/amika-lume-check/owned.txt";
    await sandbox.writeFile(home, "a");
    await sandbox.writeFile(system, "b");
    const result = await sandbox.exec(`stat -f '%Su:%Sg' ${home} ${system}`);
    expect(result.stdout).toBe("amika:staff\namika:staff\n");
  });

  it("delivers stdin to one command only", async () => {
    expect(
      (await sandbox.exec("cat", { input: "only-for-this-command" })).stdout,
    ).toBe("only-for-this-command");
    // A command with no input reads end of file at once.
    expect(await sandbox.exec("cat")).toEqual({
      exitCode: 0,
      stdout: "",
      stderr: "",
    });
  });

  it("runs sudo commands as root with root's home", async () => {
    expect(
      (await sandbox.exec(`printf '%s %s' "$(id -un)" "$HOME"`, { sudo: true }))
        .stdout,
    ).toBe("root /var/root");
  });
});

/**
 * Checks a VM from a macOS image (`macos-image/build.sh`, milestone 2 of
 * spec 028): amikad does not run until the rig has new credentials, and
 * then it serves the SSH bridge under launchd. Run on an Apple Silicon Mac
 * with Lume:
 *
 *   TEST_LUME_IMAGE=<a stopped image VM in Lume's default storage> \
 *   LUME_STORAGE_DIR=... LUME_STATE_DIR=... \
 *   pnpm --filter @amika/sandbox test:integration src/providers/lume/macos-image
 *
 * The steps follow `@amika/sandbox-provisioning`'s no-relay SSH setup, with
 * `launchctl` in place of systemd.
 */
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sandboxProviderConfigsFromEnv } from "../../config-from-env";
import type { SandboxCtx } from "../../logger";
import { moduleLogger } from "../../logger";
import type { Sandbox } from "../provider";
import type { LumeConfig } from "./config";
import lumeProvider from "./provider";

const image = process.env.TEST_LUME_IMAGE;
const JOB = "/usr/local/lib/amikad/com.amika.amikad.plist";
const LOADED_JOB = "/Library/LaunchDaemons/com.amika.amikad.plist";
const STATUS = "http://127.0.0.1:60999/v1/status";
const MANAGED_SSHD_PORT = 60997;

describe.skipIf(!image)("lume VM from a macOS image", () => {
  // Read the env in `beforeAll`: vitest runs this body even when the
  // block is skipped, and the config read throws without the Lume env.
  let config: LumeConfig;
  let provider: ReturnType<typeof lumeProvider>;
  const ctx: SandboxCtx = {
    logger: moduleLogger({ test: "lume-macos-image" }),
    childCtx: () => ctx,
  };
  let sandbox: Sandbox;

  beforeAll(async () => {
    config = sandboxProviderConfigsFromEnv({
      ...process.env,
      DAYTONA_API_KEY: "unused",
      LUME_ENABLED: "true",
    }).lume!;
    provider = lumeProvider(config);
    sandbox = await provider.sandboxes.create(ctx, {
      name: `lume-image-${Date.now()}`,
      snapshot: image!,
      services: [],
    });
  });
  afterAll(async () => {
    await sandbox?.delete();
  });

  const run = async (command: string, input?: string) => {
    const result = await sandbox.exec(command, { sudo: true, input });
    expect(result, command).toMatchObject({ exitCode: 0 });
    return result.stdout;
  };
  const waitForBridge = () =>
    run(
      `for _ in $(seq 1 50); do curl -sf --max-time 1 ${STATUS} && exit 0; sleep 0.2; done; exit 1`,
    );

  it("does not run amikad before provisioning", async () => {
    const result = await sandbox.exec(
      `launchctl print system/com.amika.amikad >/dev/null 2>&1 && echo loaded
test -e /private/var/lib/amikad/connect-token && echo token
curl -sf --max-time 2 ${STATUS} >/dev/null && echo serving
true`,
      { sudo: true },
    );
    expect(result).toMatchObject({ exitCode: 0, stdout: "" });
  });

  it("serves the SSH bridge under launchd after new credentials", async () => {
    await sandbox.exec(
      "ssh-keygen -q -t ed25519 -N '' -f ~/user-key && cat ~/user-key.pub",
    );
    const userKey = (await sandbox.readFile("/Users/amika/user-key.pub"))!;
    await run("amikad setup sshd --force-overwrite");
    await run("amikad authorized-keys set", userKey.toString());
    expect(await run("amikad host-key show")).toMatch(/^ssh-ed25519 /);
    await run(
      "amikad connect-token set",
      `${randomBytes(32).toString("base64url")}\n`,
    );
    await run(
      `install -m 644 -o root -g wheel ${JOB} ${LOADED_JOB} && launchctl bootstrap system ${LOADED_JOB} && rm ${LOADED_JOB}`,
    );

    expect(JSON.parse(await waitForBridge())).toMatchObject({
      mode: "beta_no_relay",
      port: 60999,
    });
    // The managed sshd admits the user key, and the management key still
    // works on the system sshd.
    const login = await sandbox.exec(
      `ssh -i ~/user-key -p ${MANAGED_SSHD_PORT} -o BatchMode=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null amika@127.0.0.1 echo ok`,
    );
    expect(login).toMatchObject({ exitCode: 0, stdout: "ok\n" });
  });

  it("restarts amikad when it stops", async () => {
    await run("pkill -x amikad");
    expect(JSON.parse(await waitForBridge())).toMatchObject({
      mode: "beta_no_relay",
    });
  });

  it("does not start amikad again after the rig stops and starts", async () => {
    await sandbox.stop();
    await sandbox.start();
    const result = await sandbox.exec(
      `launchctl print system/com.amika.amikad >/dev/null 2>&1 && echo loaded
pgrep -x amikad >/dev/null && echo running
true`,
      { sudo: true },
    );
    expect(result).toMatchObject({ exitCode: 0, stdout: "" });
  });
});

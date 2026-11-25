/**
 * Commands and files over SSH. Compute Engine has no API for either.
 *
 * - **Address.** The VM's external IP, port 22. Create opens port 22 to
 *   VMs with the `amika-rig` network tag (`./firewall.ts`).
 * - **Login.** User `amika` with the VM's derived key (`./ssh-key.ts`).
 * - **Host key.** Never trusted on first use. Google's guest agent writes
 *   the VM's host keys to its guest attributes (`hostkeys/`), which we read
 *   through the Compute API with the service account. The connection is
 *   refused unless the server shows one of those keys.
 * - **Connections.** One connection per VM is shared by the calls made
 *   while it is open, and closed after a short idle time, so a provisioning
 *   run of many commands does not pay for a handshake each time.
 * - **Readiness.** A new or started VM refuses SSH until it has booted and
 *   the guest agent has made the user. {@link waitForGcpSsh} retries until
 *   SSH works.
 * - **Key rotation.** A login refused for its key puts the current derived
 *   key back in the VM's metadata (`./ssh-key-metadata.ts`) and tries again
 *   while the guest agent installs it.
 */
import { Client, type ClientChannel, type SFTPWrapper } from "ssh2";
import { z } from "zod";
import type { StreamCommandHandlers } from "../../provider";
import { SandboxFileTooLargeError } from "../../provider";
import { isNotFound, requestJson, type GcpTarget } from "./client";
import { gcpSshKey, GCP_SSH_USER } from "./ssh-key";
import { ensureGcpSshKeyMetadata } from "./ssh-key-metadata";

/** How long a VM may take to accept SSH after it starts. */
const SSH_READY_TIMEOUT_MS = 5 * 60_000;
const SSH_READY_POLL_MS = 3_000;

/** The TCP connect and SSH handshake timeout. */
const CONNECT_TIMEOUT_MS = 20_000;

/** Close a shared connection after this long with no call on it. */
const IDLE_CLOSE_MS = 30_000;

/** How long to wait for the guest agent to install a repaired key. */
const KEY_REPAIR_TIMEOUT_MS = 90_000;

/** The longest one command may run. */
export const GCP_EXEC_TIMEOUT_MS = 30 * 60_000;

const instanceAddressSchema = z.object({
  status: z.string(),
  networkInterfaces: z
    .array(
      z.object({
        accessConfigs: z
          .array(z.object({ natIP: z.string().optional() }))
          .optional(),
      }),
    )
    .optional(),
});

const guestAttributesSchema = z.object({
  queryValue: z
    .object({
      items: z
        .array(
          z.object({
            namespace: z.string().optional(),
            key: z.string().optional(),
            value: z.string().optional(),
          }),
        )
        .optional(),
    })
    .optional(),
});

/** Raised while a VM cannot take SSH yet; {@link waitForGcpSsh} retries it. */
export class GcpSshNotReadyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GcpSshNotReadyError";
  }
}

interface PooledConnection {
  client: Client;
  active: number;
  idleTimer: NodeJS.Timeout | null;
}

const pool = new Map<string, Promise<PooledConnection>>();

function poolKey(target: GcpTarget, instanceName: string): string {
  return `${target.credentials.keyHash}:${target.zonePath}:${instanceName}`;
}

/**
 * Run `fn` with a connection to the VM, opening one or sharing the open one.
 * A failed connection is dropped from the pool, so the next call dials again.
 */
export async function withGcpSsh<T>(
  target: GcpTarget,
  instanceName: string,
  fn: (client: Client) => Promise<T>,
): Promise<T> {
  const key = poolKey(target, instanceName);
  const pending = pool.get(key) ?? dial(key, target, instanceName);
  const conn = await pending;
  conn.active++;
  if (conn.idleTimer) {
    clearTimeout(conn.idleTimer);
    conn.idleTimer = null;
  }
  try {
    return await fn(conn.client);
  } finally {
    conn.active--;
    if (conn.active === 0) {
      conn.idleTimer = setTimeout(() => {
        // Out of the pool first, so no call picks up a closing client.
        if (pool.get(key) === pending) pool.delete(key);
        conn.client.end();
      }, IDLE_CLOSE_MS);
      conn.idleTimer.unref();
    }
  }
}

/**
 * Open a connection and put it in the pool. It leaves the pool when it
 * fails or closes, but only if it is still the pool's entry: a newer
 * connection to the same VM keeps its place.
 */
function dial(
  key: string,
  target: GcpTarget,
  instanceName: string,
): Promise<PooledConnection> {
  const drop = () => {
    if (pool.get(key) === pending) pool.delete(key);
  };
  const pending = connectRepairingKey(target, instanceName, drop);
  pool.set(key, pending);
  pending.catch(drop);
  return pending;
}

/**
 * Open a connection. When the VM refuses our key and its metadata holds an
 * older one (the service account key was rotated), install the current key
 * and keep trying while the guest agent picks it up.
 */
async function connectRepairingKey(
  target: GcpTarget,
  instanceName: string,
  onClose: () => void,
): Promise<PooledConnection> {
  try {
    return await openConnection(target, instanceName, onClose);
  } catch (error) {
    if (!isAuthFailure(error)) throw error;
    if (!(await ensureGcpSshKeyMetadata(target, instanceName))) throw error;
  }
  const deadline = Date.now() + KEY_REPAIR_TIMEOUT_MS;
  for (;;) {
    await new Promise((r) => setTimeout(r, SSH_READY_POLL_MS));
    try {
      return await openConnection(target, instanceName, onClose);
    } catch (error) {
      if (!isAuthFailure(error) || Date.now() >= deadline) throw error;
    }
  }
}

function isAuthFailure(error: unknown): boolean {
  return (error as { level?: string })?.level === "client-authentication";
}

/** Close any shared connection to the VM, as before it stops or is deleted. */
export function closeGcpSsh(target: GcpTarget, instanceName: string): void {
  const key = poolKey(target, instanceName);
  const pending = pool.get(key);
  pool.delete(key);
  pending?.then((conn) => conn.client.end()).catch(() => undefined);
}

/** Wait until the VM takes SSH and runs a command. */
export async function waitForGcpSsh(
  target: GcpTarget,
  instanceName: string,
  timeoutMs: number = SSH_READY_TIMEOUT_MS,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const result = await execGcp(target, instanceName, "true");
      if (result.exitCode === 0) return;
      throw new GcpSshNotReadyError(`exit code ${result.exitCode}`);
    } catch (error) {
      if (Date.now() >= deadline) {
        throw new Error(
          `GCP VM ${instanceName} did not accept SSH within ` +
            `${Math.round(timeoutMs / 1000)}s: ${(error as Error).message}`,
        );
      }
      if (!isRetryableConnectError(error)) throw error;
      closeGcpSsh(target, instanceName);
      await new Promise((r) => setTimeout(r, SSH_READY_POLL_MS));
    }
  }
}

/**
 * Errors a booting VM gives: no address yet, no host keys yet, the port
 * closed or filtered, or the user's key not installed yet.
 */
function isRetryableConnectError(error: unknown): boolean {
  if (error instanceof GcpSshNotReadyError) return true;
  const err = error as { code?: string; level?: string; message?: string };
  return (
    err.level === "client-authentication" ||
    err.level === "client-timeout" ||
    err.code === "ECONNREFUSED" ||
    err.code === "ECONNRESET" ||
    err.code === "ETIMEDOUT" ||
    err.code === "EHOSTUNREACH" ||
    /Timed out while waiting for handshake/.test(err.message ?? "")
  );
}

async function openConnection(
  target: GcpTarget,
  instanceName: string,
  onClose: () => void,
): Promise<PooledConnection> {
  const [host, hostKeys] = await Promise.all([
    externalIp(target, instanceName),
    publishedHostKeys(target, instanceName),
  ]);
  const client = new Client();
  const key = gcpSshKey(target.credentials, instanceName);
  await new Promise<void>((resolve, reject) => {
    client
      .once("ready", () => resolve())
      .once("error", reject)
      .connect({
        host,
        port: 22,
        username: GCP_SSH_USER,
        privateKey: key.privateKey,
        readyTimeout: CONNECT_TIMEOUT_MS,
        keepaliveInterval: 15_000,
        hostVerifier: (presented: Buffer) =>
          hostKeys.has(presented.toString("base64")),
      });
  });
  const conn: PooledConnection = { client, active: 0, idleTimer: null };
  client.on("error", () => undefined);
  client.once("close", () => {
    if (conn.idleTimer) clearTimeout(conn.idleTimer);
    onClose();
  });
  return conn;
}

async function externalIp(
  target: GcpTarget,
  instanceName: string,
): Promise<string> {
  const instance = await requestJson(
    target,
    instanceAddressSchema,
    "GET",
    `${target.zonePath}/instances/${encodeURIComponent(instanceName)}`,
  );
  if (instance.status !== "RUNNING") {
    throw new GcpSshNotReadyError(
      `GCP VM ${instanceName} is ${instance.status}, not RUNNING`,
    );
  }
  const ip = instance.networkInterfaces?.[0]?.accessConfigs?.[0]?.natIP;
  if (!ip) {
    throw new GcpSshNotReadyError(`GCP VM ${instanceName} has no external IP`);
  }
  return ip;
}

/**
 * The base64 key blobs the guest agent published for the VM. The agent
 * writes `hostkeys/<type>` with the key's base64 part; we also accept a
 * whole `type base64` line.
 */
async function publishedHostKeys(
  target: GcpTarget,
  instanceName: string,
): Promise<Set<string>> {
  let attributes: z.infer<typeof guestAttributesSchema>;
  try {
    attributes = await requestJson(
      target,
      guestAttributesSchema,
      "GET",
      `${target.zonePath}/instances/${encodeURIComponent(instanceName)}/getGuestAttributes`,
      { query: { queryPath: "hostkeys/" } },
    );
  } catch (error) {
    if (isNotFound(error)) {
      throw new GcpSshNotReadyError(
        `GCP VM ${instanceName} has not published its SSH host keys yet`,
      );
    }
    throw error;
  }
  const keys = new Set<string>();
  for (const item of attributes.queryValue?.items ?? []) {
    const value = item.value?.trim();
    if (!value) continue;
    const parts = value.split(/\s+/);
    keys.add(parts.length > 1 ? parts[1] : parts[0]);
  }
  if (keys.size === 0) {
    throw new GcpSshNotReadyError(
      `GCP VM ${instanceName} has not published its SSH host keys yet`,
    );
  }
  return keys;
}

export interface GcpExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Run a command line (already quoted for the login shell) and collect its
 * output. With `handlers`, output goes to them and is not kept.
 */
export async function execGcp(
  target: GcpTarget,
  instanceName: string,
  commandLine: string,
  opts: { input?: string; handlers?: StreamCommandHandlers } = {},
): Promise<GcpExecResult> {
  return withGcpSsh(target, instanceName, (client) =>
    runOnChannel(client, commandLine, opts),
  );
}

function runOnChannel(
  client: Client,
  commandLine: string,
  opts: { input?: string; handlers?: StreamCommandHandlers },
): Promise<GcpExecResult> {
  return new Promise((resolve, reject) => {
    client.exec(
      commandLine,
      (err: Error | undefined, channel: ClientChannel) => {
        if (err) {
          reject(err);
          return;
        }
        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];
        const outDecoder = new TextDecoder();
        const errDecoder = new TextDecoder();
        let exitCode: number | null = null;
        const timer = setTimeout(() => {
          channel.close();
          reject(
            new Error(
              `Command did not finish within ${GCP_EXEC_TIMEOUT_MS / 60_000} minutes`,
            ),
          );
        }, GCP_EXEC_TIMEOUT_MS);
        channel.on("data", (chunk: Buffer) => {
          if (opts.handlers) {
            opts.handlers.onStdout(outDecoder.decode(chunk, { stream: true }));
          } else stdout.push(chunk);
        });
        channel.stderr.on("data", (chunk: Buffer) => {
          if (opts.handlers) {
            opts.handlers.onStderr?.(
              errDecoder.decode(chunk, { stream: true }),
            );
          } else stderr.push(chunk);
        });
        channel.on("exit", (code: number | null) => {
          // A command killed by a signal has no code. 128 marks it as one,
          // as a shell would, without the signal's number.
          exitCode = code ?? 128;
        });
        channel.on("close", () => {
          clearTimeout(timer);
          if (exitCode === null) {
            // The connection dropped (or the VM stopped) mid-command: no
            // exit status came, so the outcome is unknown, not a failure.
            reject(
              new Error("The SSH connection closed before the command exited"),
            );
            return;
          }
          resolve({
            exitCode,
            stdout: Buffer.concat(stdout).toString("utf8"),
            stderr: Buffer.concat(stderr).toString("utf8"),
          });
        });
        channel.on("error", (error: Error) => {
          clearTimeout(timer);
          reject(error);
        });
        if (opts.input !== undefined) channel.end(opts.input);
        else channel.end();
      },
    );
  });
}

/** Run `fn` with an SFTP session on the VM. */
async function withSftp<T>(
  target: GcpTarget,
  instanceName: string,
  fn: (sftp: SFTPWrapper) => Promise<T>,
): Promise<T> {
  return withGcpSsh(target, instanceName, async (client) => {
    const sftp = await new Promise<SFTPWrapper>((resolve, reject) =>
      client.sftp((err: Error | undefined, session: SFTPWrapper) =>
        err ? reject(err) : resolve(session),
      ),
    );
    try {
      return await fn(sftp);
    } finally {
      sftp.end();
    }
  });
}

/** SFTP status codes (draft-ietf-secsh-filexfer-02). */
const SFTP_NO_SUCH_FILE = 2;
const SFTP_PERMISSION_DENIED = 3;

export function isSftpNoSuchFile(error: unknown): boolean {
  return (error as { code?: number })?.code === SFTP_NO_SUCH_FILE;
}

export function isSftpPermissionDenied(error: unknown): boolean {
  return (error as { code?: number })?.code === SFTP_PERMISSION_DENIED;
}

/** A file's bytes as the `amika` user; `null` when it does not exist. */
export async function readGcpFile(
  target: GcpTarget,
  instanceName: string,
  path: string,
  maxBytes?: number,
): Promise<Uint8Array | null> {
  try {
    return await withSftp(target, instanceName, async (sftp) => {
      const parts: Buffer[] = [];
      let total = 0;
      const stream = sftp.createReadStream(path);
      for await (const chunk of stream as AsyncIterable<Buffer>) {
        total += chunk.byteLength;
        if (maxBytes !== undefined && total > maxBytes) {
          stream.destroy();
          throw new SandboxFileTooLargeError(path, maxBytes);
        }
        parts.push(chunk);
      }
      return new Uint8Array(Buffer.concat(parts, total));
    });
  } catch (error) {
    if (isSftpNoSuchFile(error)) return null;
    throw error;
  }
}

/** Write a file as the `amika` user. The parent directory must exist. */
export async function writeGcpFile(
  target: GcpTarget,
  instanceName: string,
  path: string,
  content: Buffer | string,
): Promise<void> {
  await withSftp(
    target,
    instanceName,
    (sftp) =>
      new Promise<void>((resolve, reject) =>
        sftp.writeFile(path, content, (err: Error | null | undefined) =>
          err ? reject(err) : resolve(),
        ),
      ),
  );
}

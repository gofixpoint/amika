/**
 * The system `ssh` client, pointed at one guest.
 *
 * The user's own SSH config and agent never apply (`-F /dev/null`,
 * `IdentitiesOnly`). Each VM has its own known-hosts file, because clones of
 * one template share host keys and a deleted VM's IP goes to the next one.
 */
import { chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runProcess, type ProcessResult, type ProcessRunner } from "./process";

export interface GuestAddress {
  ip: string;
  knownHostsFile: string;
}

/** The env var that carries the bootstrap password to the askpass helper. */
const PASSWORD_VAR = "AMIKA_LUME_BOOTSTRAP_PASSWORD";

export class GuestSsh {
  constructor(
    private readonly bin = "ssh",
    private readonly runner: ProcessRunner = runProcess,
  ) {}

  /** Run `line` as `user`, logged in with the private key in `keyFile`. */
  withKey(
    guest: GuestAddress,
    keyFile: string,
    user: string,
    line: string,
    input?: Buffer | string,
  ): Promise<ProcessResult> {
    return this.runner(
      this.bin,
      [
        ...baseArgs(guest),
        ...["-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes"],
        ...["-o", "PasswordAuthentication=no"],
        ...["-o", "KbdInteractiveAuthentication=no"],
        ...["-i", keyFile, `${user}@${guest.ip}`, line],
      ],
      { input },
    );
  }

  /**
   * Run `line` as `user`, logged in with `password`. ssh reads a password
   * only from a terminal or an askpass program, so `askpassFile` (see
   * {@link writeAskpass}) prints it from the environment; it is never in
   * argv.
   */
  withPassword(
    guest: GuestAddress,
    askpassFile: string,
    password: string,
    user: string,
    line: string,
    input?: Buffer | string,
  ): Promise<ProcessResult> {
    return this.runner(
      this.bin,
      [
        ...baseArgs(guest),
        ...["-o", "PubkeyAuthentication=no"],
        ...["-o", "PreferredAuthentications=password,keyboard-interactive"],
        ...["-o", "NumberOfPasswordPrompts=1"],
        `${user}@${guest.ip}`,
        line,
      ],
      {
        input,
        env: {
          ...process.env,
          SSH_ASKPASS: askpassFile,
          SSH_ASKPASS_REQUIRE: "force",
          [PASSWORD_VAR]: password,
        },
      },
    );
  }
}

/** Write the askpass helper into `dir` and return its path. */
export async function writeAskpass(dir: string): Promise<string> {
  const path = join(dir, "askpass");
  await writeFile(path, `#!/bin/sh\nprintf '%s\\n' "$${PASSWORD_VAR}"\n`, {
    mode: 0o700,
  });
  // `mode` applies only when the file is new.
  await chmod(path, 0o700);
  return path;
}

function baseArgs(guest: GuestAddress): string[] {
  return [
    ...["-F", "/dev/null", "-T"],
    ...["-o", "LogLevel=ERROR"],
    // The banner exchange can take seconds just after boot.
    ...["-o", "ConnectTimeout=10"],
    ...["-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=4"],
    ...["-o", `UserKnownHostsFile=${guest.knownHostsFile}`],
    ...["-o", "GlobalKnownHostsFile=/dev/null"],
    ...["-o", "StrictHostKeyChecking=accept-new"],
  ];
}

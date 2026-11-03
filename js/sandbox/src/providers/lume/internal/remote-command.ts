/**
 * The command line sent over SSH. sshd runs it with the login user's shell
 * (`$SHELL -c <line>`), so the line only starts `/bin/sh`, and the caller's
 * command runs in a POSIX shell whatever that login shell is.
 */
import { shellQuote } from "../../../util/shell";

export interface RemoteCommandOptions {
  cwd?: string;
  env?: Record<string, string>;
  /** Run as root, with root's `HOME`. */
  sudo?: boolean;
}

export function remoteCommand(
  command: string,
  { cwd, env = {}, sudo = false }: RemoteCommandOptions = {},
): string {
  // sshd gives the command a short default PATH. The image sets the rig's
  // PATH in /etc/paths, as login shells on macOS read it.
  const lines = ['eval "$(/usr/libexec/path_helper -s)"'];
  if (cwd !== undefined) lines.push(`cd -- ${shellQuote(cwd)} || exit 1`);
  for (const [name, value] of Object.entries(env)) {
    if (!ENV_NAME.test(name)) throw new Error(`Invalid env var name: ${name}`);
    lines.push(`export ${name}=${shellQuote(value)}`);
  }
  lines.push(command);
  const shell = `/bin/sh -c ${shellQuote(lines.join("\n"))}`;
  return sudo ? `sudo -n -H ${shell}` : shell;
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * The SSH bootstrap of a new VM (spec 026, "Management access at first
 * boot"). The template has a bootstrap login with a known password; this
 * replaces it with a key that works for this VM only, then turns password
 * login off.
 *
 * The order matters: password login goes off only after key login and
 * passwordless `sudo` work, or a failed step locks everyone out of the VM.
 */
import { shellQuote } from "../../../util/shell";
import type { GuestAddress, GuestSsh } from "./guest-ssh";
import type { ProcessResult } from "./process";

/** The user that commands and file writes run as, as on Linux images. */
export const AMIKA_USER = "amika";
export const AMIKA_HOME = "/Users/amika";

export interface BootstrapLogin {
  askpassFile: string;
  user: string;
  password: string;
}

export async function bootstrapGuest(
  ssh: GuestSsh,
  guest: GuestAddress,
  login: BootstrapLogin,
  keyFile: string,
  publicKey: string,
  deadline: number,
): Promise<void> {
  const withPassword = (line: string, input?: string) =>
    ssh.withPassword(
      guest,
      login.askpassFile,
      login.password,
      login.user,
      line,
      input,
    );
  const withKey = (line: string) =>
    ssh.withKey(guest, keyFile, AMIKA_USER, line);

  await waitForSsh(() => withPassword("true"), deadline, "password login");
  // `sudo -S` reads the bootstrap user's password from stdin.
  check(
    "create the amika user",
    await withPassword(
      `sudo -S -p '' /bin/sh -c ${shellQuote(amikaUserScript(publicKey))}`,
      `${login.password}\n`,
    ),
  );
  check("log in with the key", await withKey("sudo -n true"));
  check(
    "turn off password login",
    await withKey(`sudo -n /bin/sh -c ${shellQuote(PASSWORD_OFF_SCRIPT)}`),
  );
  await waitForSsh(() => withKey("true"), deadline, "key login after restart");
  const attempt = await withPassword("true");
  if (
    attempt.exitCode !== 255 ||
    !/Permission denied/.test(String(attempt.stderr))
  ) {
    throw new Error("Password login is still on after the bootstrap");
  }
}

/** Retry `attempt` until it exits 0, about once a second, until `deadline`. */
export async function waitForSsh(
  attempt: () => Promise<ProcessResult>,
  deadline: number,
  what: string,
): Promise<void> {
  for (;;) {
    const result = await attempt();
    if (result.exitCode === 0) return;
    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out waiting for ${what}: ${String(result.stderr).trim()}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
}

/**
 * The system sshd reads only this root-owned file for keys. amikad's own
 * sshd reads `~/.ssh/authorized_keys`, and amikad replaces that file with
 * the user's keys. So the management key and the user keys stay apart: a
 * user key does not log in on port 22, and amikad cannot remove the
 * management key.
 */
const MANAGEMENT_KEYS_DIR = "/private/var/db/amika";
const MANAGEMENT_KEYS = `${MANAGEMENT_KEYS_DIR}/management_authorized_keys`;

/**
 * Run as root. Adds `amika` when the template does not have it (with `dscl`,
 * since `sysadminctl` takes about 25 s), and lets it log in over SSH with
 * the key, and use `sudo` with no password. Remote Login on the template
 * admits only the `com.apple.access_ssh` group, when that group exists.
 */
function amikaUserScript(publicKey: string): string {
  return `set -eu
if ! dscl . -read /Users/${AMIKA_USER} >/dev/null 2>&1; then
  uid=$(dscl . -list /Users UniqueID | awk '$2 > max { max = $2 } END { print (max >= 501 ? max + 1 : 501) }')
  dscl . -create /Users/${AMIKA_USER}
  dscl . -create /Users/${AMIKA_USER} UserShell /bin/zsh
  dscl . -create /Users/${AMIKA_USER} RealName Amika
  dscl . -create /Users/${AMIKA_USER} UniqueID "$uid"
  dscl . -create /Users/${AMIKA_USER} PrimaryGroupID 20
  dscl . -create /Users/${AMIKA_USER} NFSHomeDirectory ${AMIKA_HOME}
  dscl . -passwd /Users/${AMIKA_USER} "$(openssl rand -hex 24)"
  createhomedir -c -u ${AMIKA_USER} >/dev/null
fi
if dscl . -read /Groups/com.apple.access_ssh >/dev/null 2>&1; then
  dseditgroup -o edit -a ${AMIKA_USER} -t user com.apple.access_ssh
fi
install -d -m 700 -o ${AMIKA_USER} -g staff ${AMIKA_HOME}/.ssh
install -d -m 755 -o root -g wheel ${MANAGEMENT_KEYS_DIR}
printf '%s\\n' ${shellQuote(publicKey)} > ${MANAGEMENT_KEYS}
chmod 644 ${MANAGEMENT_KEYS}
printf '%s\\n' 'AuthorizedKeysFile ${MANAGEMENT_KEYS}' > /etc/ssh/sshd_config.d/010-amika-keys.conf
printf '%s\\n' '${AMIKA_USER} ALL=(ALL) NOPASSWD: ALL' > /etc/sudoers.d/${AMIKA_USER}
chmod 440 /etc/sudoers.d/${AMIKA_USER}
visudo -cf /etc/sudoers.d/${AMIKA_USER} >/dev/null
`;
}

/** Run as root. sshd reads `sshd_config.d` on start, so restart it. */
const PASSWORD_OFF_SCRIPT = `set -eu
printf '%s\\n' 'PasswordAuthentication no' 'KbdInteractiveAuthentication no' > /etc/ssh/sshd_config.d/011-amika-password-off.conf
launchctl kickstart -k system/com.openssh.sshd
`;

function check(step: string, result: ProcessResult): void {
  if (result.exitCode !== 0) {
    throw new Error(
      `SSH bootstrap could not ${step} (exit ${result.exitCode}): ${String(result.stderr).trim()}`,
    );
  }
}

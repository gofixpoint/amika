/**
 * The system keychains hostd keeps its secrets in: the macOS login keychain
 * (`security`) and the Linux Secret Service (`secret-tool`). Which one a
 * machine has is the platform's to say (`HostPlatform.keychain`);
 * `../internal/credentials.ts` builds the secret store on top.
 */
import { spawnSync } from "node:child_process";
import { ConfigError } from "../internal/config.js";

/**
 * A system keychain holding hostd's items by name. Each method throws
 * `ConfigError` when the keychain cannot be used (locked, say); `get` returns
 * `undefined` only when it is sure the item is not there.
 */
export interface Keychain {
  readonly description: string;
  get(name: SecretName): string | undefined;
  set(name: SecretName, value: string): void;
}

export type SecretName = "api-key" | "secret-key" | "attachment-credential";

/** The result of running a program, as `spawnSync` reports it. */
export interface RunResult {
  status: number | null;
  stdout: string;
  stderr?: string;
  /** The signal that killed it, e.g. `SIGINT` from the operator's Ctrl-C. */
  signal?: NodeJS.Signals | null;
  error?: Error;
}

export type Runner = (
  command: string,
  args: readonly string[],
  input?: string,
) => RunResult;

/**
 * A keychain command was killed by Ctrl-C. The terminal sends it to the
 * whole foreground process group, so it reaches the keychain program too.
 */
export class KeychainInterrupted extends ConfigError {
  override name = "KeychainInterrupted";
}

const SERVICE = "amika-hostd";
const LABELS: Record<SecretName, string> = {
  "api-key": "Amika API key for amika-hostd",
  "secret-key": "amika-hostd secret key",
  "attachment-credential": "amika-hostd tunnel attachment credential",
};
/** Long enough for a keychain to ask the operator to unlock it. */
const KEYCHAIN_TIMEOUT_MS = 60_000;

/**
 * The macOS login keychain, through `security`. Items are generic passwords
 * under service `amika-hostd`, one account per secret. Every command names
 * the login keychain: without one, `security` uses the default keychain,
 * which a user can change to another (separately locked, or temporary) one.
 */
export function macOSKeychain(run: Runner): Keychain {
  const description = "your macOS login keychain";
  const refuse = (what: string) =>
    new ConfigError(
      `Cannot ${what} ${description}; unlock it and run \`amika-hostd setup\` again, or set \`secret_store = "file"\` to keep secrets in files`,
    );
  let loginKeychain: string | undefined;
  /** The login keychain's path, as `security login-keychain` prints it. */
  const login = (): string => {
    if (loginKeychain !== undefined) return loginKeychain;
    const result = checked(run("security", ["login-keychain"]));
    // It prints the path quoted and indented: `    "/Users/…/login.keychain-db"`.
    const path = /"(.+)"/.exec(result.stdout)?.[1] ?? result.stdout.trim();
    if (result.status !== 0 || path === "") {
      // Unlocking cannot help here: there is no login keychain to unlock.
      throw new ConfigError(
        `Cannot find ${description}, so amika-hostd has nowhere to keep its secrets; set \`secret_store = "file"\` to keep them in files`,
      );
    }
    loginKeychain = path;
    return path;
  };
  return {
    description,
    get(name) {
      const result = checked(
        run("security", [
          "find-generic-password",
          "-s",
          SERVICE,
          "-a",
          name,
          "-w",
          login(),
        ]),
      );
      const value = result.status === 0 ? result.stdout.trim() : "";
      if (value !== "") return value;
      // 44 is errSecItemNotFound; anything else (a locked keychain, a
      // dismissed prompt) is a keychain that cannot be read.
      if (result.status === 44) return undefined;
      throw refuse(`read the ${LABELS[name]} from`);
    },
    set(name, value) {
      // The value is quoted into a `security -i` command; nothing a secret or
      // API key may hold (printable ASCII without spaces) needs more, but
      // quotes and backslashes would.
      if (!/^[\x21-\x7e]+$/.test(value) || /["\\]/.test(value)) {
        throw new ConfigError(
          `The ${LABELS[name]} has spaces, quotes or backslashes, so it cannot go in ${description}; set \`secret_store = "file"\` to keep it in a file`,
        );
      }
      // `security -i` reads the command from stdin, which keeps the value
      // out of the process list. Its exit status does not report a failed
      // command, so read the value back to confirm it was stored.
      checked(
        run(
          "security",
          ["-i"],
          `add-generic-password -U -s ${SERVICE} -a ${name} -l "${LABELS[name]}" -w "${value}" ${quoted(login())}\n`,
        ),
      );
      if (this.get(name) !== value)
        throw refuse(`store the ${LABELS[name]} in`);
    },
  };
}

/**
 * `text` as one double-quoted word for a `security -i` command line, whose
 * parser takes `\\` and `\"` as escapes inside quotes. For the keychain path,
 * which can hold spaces.
 */
function quoted(text: string): string {
  return `"${text.replace(/["\\]/g, (char) => `\\${char}`)}"`;
}

/**
 * The Secret Service (GNOME Keyring, KWallet) on a Linux desktop session,
 * through `secret-tool`. Items carry attributes `service=amika-hostd` and
 * `account=<secret>`.
 */
export function secretServiceKeychain(run: Runner): Keychain {
  const description = "your desktop keyring (Secret Service)";
  const files = 'set `secret_store = "file"` to keep secrets in files';
  const attributes = (name: SecretName) => [
    "service",
    SERVICE,
    "account",
    name,
  ];
  /** Run `secret-tool`, refusing if it is missing, hung, or has no service. */
  const secretTool = (args: readonly string[], input?: string): RunResult => {
    const result = checked(run("secret-tool", args, input));
    const code = errorCode(result.error);
    if (code === "ENOENT") {
      throw new ConfigError(
        `secret-tool is not installed, so amika-hostd cannot use ${description}; install it (libsecret-tools, or libsecret) if this session has a desktop keyring, or ${files}`,
      );
    }
    if (result.error || result.signal) {
      throw new ConfigError(
        `secret-tool did not finish (${result.signal ?? code}), so amika-hostd cannot use ${description}; answer or dismiss any keyring prompt and run \`amika-hostd setup\` again, or ${files}`,
      );
    }
    // A session bus with no keyring daemon on it, as over SSH to a server.
    // libsecret strips the D-Bus error name (`ServiceUnknown`) and prints
    // only its message, which depends on the bus (dbus-daemon, dbus-broker).
    if (NO_SECRET_SERVICE.test(result.stderr ?? "")) {
      throw new ConfigError(
        `No desktop keyring (Secret Service) answers on this session's D-Bus (${detail(result)}), so amika-hostd has nowhere to keep its secrets; ${files}`,
      );
    }
    return result;
  };
  const refuse = (what: string, result: RunResult) =>
    new ConfigError(
      `Cannot ${what} ${description} (${detail(result)}); unlock it and run \`amika-hostd setup\` again, or ${files}`,
    );
  /**
   * Whether an item exists, locked or not. `search --all` lists locked items
   * without unlocking them; it prints each match (with the secret, for an
   * unlocked one), so only whether it printed anything is kept.
   */
  const exists = (name: SecretName): boolean => {
    const result = secretTool(["search", "--all", ...attributes(name)]);
    if (result.status !== 0) {
      throw refuse(`look for the ${LABELS[name]} in`, result);
    }
    return result.stdout.trim() !== "";
  };
  return {
    description,
    get(name) {
      const result = secretTool(["lookup", ...attributes(name)]);
      const value = result.status === 0 ? result.stdout.trim() : "";
      if (value !== "") return value;
      if (result.status !== 1 || result.stderr?.trim()) {
        throw refuse(`read the ${LABELS[name]} from`, result);
      }
      // A silent exit 1 means no item, but also a locked one whose unlock
      // prompt was dismissed; reading that as unset would have setup replace
      // the secret key, so check that nothing is there.
      if (!exists(name)) return undefined;
      throw new ConfigError(
        `The ${LABELS[name]} is in ${description}, but it is locked; unlock it and run \`amika-hostd setup\` again, or ${files}`,
      );
    },
    set(name, value) {
      // `store` reads the value from stdin, off the process list.
      const result = secretTool(
        ["store", `--label=${LABELS[name]}`, ...attributes(name)],
        value,
      );
      if (result.status !== 0) {
        throw refuse(`store the ${LABELS[name]} in`, result);
      }
      const stored = this.get(name);
      if (stored === undefined) {
        throw new ConfigError(
          `Stored the ${LABELS[name]} in ${description}, but cannot find it there; run \`amika-hostd setup\` again, or ${files}`,
        );
      }
      // `lookup` returns the first match across the keyring's collections,
      // which can be an older item outside the one `store` wrote to.
      if (stored !== value) {
        throw new ConfigError(
          `Another ${LABELS[name]} in ${description} shadows the one just stored; delete the stale one (see \`secret-tool search --all service ${SERVICE} account ${name}\`) and run \`amika-hostd setup\` again, or ${files}`,
        );
      }
    },
  };
}

/**
 * What `secret-tool` prints when nothing answers for the Secret Service:
 * no such service (dbus-daemon, dbus-broker), one that went away without
 * replying or never replied, or a bus it could not connect to at all.
 */
const NO_SECRET_SERVICE =
  /not provided by any \.service files|is not activatable|Could not activate remote peer|disconnected from message bus without replying|Did not receive a reply|Could not connect/i;

/** What a failed program said, for an error message; never its stdout. */
function detail(result: RunResult): string {
  const said = result.stderr?.trim().split("\n")[0];
  return said || `exit status ${result.status}`;
}

export function runProgram(
  command: string,
  args: readonly string[],
  input?: string,
): RunResult {
  const result = spawnSync(command, args, {
    input,
    encoding: "utf8",
    timeout: KEYCHAIN_TIMEOUT_MS,
    stdio: ["pipe", "pipe", "pipe"],
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    signal: result.signal,
    error: result.error,
  };
}

/** `result`, unless the operator's Ctrl-C killed the program. */
function checked(result: RunResult): RunResult {
  if (result.signal === "SIGINT") {
    throw new KeychainInterrupted("the keychain command was interrupted");
  }
  return result;
}

function errorCode(error: unknown): string {
  return typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : "unknown error";
}

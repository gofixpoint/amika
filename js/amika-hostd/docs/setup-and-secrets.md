# Setup and secret storage

## Setup

`src/internal/setup.ts` runs `amika-hostd setup`, which needs a terminal. It
edits the TOML file `up` reads (the first that exists, else the user path),
and keeps the secrets in the secret store (see [Secret storage](#secret-storage)).
It opens the store first, so with the keychain store on a machine with no
keychain it refuses before asking anything.

It asks for the hostname, defaulting to the configured one, or else the
machine's own hostname made valid (lowercased, `.local` dropped, other
characters turned into `-`), re-asking until it is valid. When the host has no
secret key it generates one (`randomBytes(32)`, hex), unless the environment
sets one, which is saved instead (Amika may already know it). With the
keychain store, setup writes `secret_store = "keychain"` to mark that the
keychain holds this host's secret key; when the file has that line but the
keychain shows no key, setup first asks whether to generate one, since the key
may be in a keychain that is only locked. When the environment chooses a store
(`AMIKA_HOSTD_SECRET_STORE`) other than the one the file alone would (its
`secret_store`, else the keychain default), setup writes `secret_store` to
match where it kept the secrets, so the choice outlasts the variable, and says
so when it replaces a different one. An existing secret key is kept, but on a
rerun setup asks whether to regenerate it. Then it asks for the Amika API key,
with input hidden, or on a rerun whether to replace the stored one; an API key
in the environment is used instead, and setup does not ask. Before the prompt
it names the page that creates one, `/settings/api-keys` on the configured
API URL's origin.

### Runtimes

Setup then asks which runtimes the host runs
(`src/internal/runtime-choice.ts`):

- It asks one yes/no question for each runtime this machine can run
  (`HostPlatform.runtimes`), and never about one it cannot.
  - smol: where the smolmachines engine runs (Linux x64 or arm64 with
    glibc 2.34+, and Apple Silicon).
  - lume: Apple Silicon only.
  - bare_metal: Linux and macOS.
- Each question defaults to what the config says. On a new host, only smol
  is on. A rerun that answers nothing changes nothing.
- Each question says what turning the runtime on installs. The Lume
  question gives the cost of the macOS image (`MACOS_IMAGE_COST`).
- Setup refuses, with nothing changed, to:
  - leave no runtime on
  - keep on a runtime this machine cannot run (`--disable` turns it off)
  - turn off a runtime that has rigs in `machines.json`

Setup writes the answers as `capabilities update` does (`updateRuntimes`).
Turning on Lume adds its `storage_dir` and the `macos-coder` preset. A
config without smol gets no default `[sizes]` or `[presets.*]`.

Then setup installs what each runtime that is on needs
(`src/internal/runtime-install.ts`). `planInstalls` checks the machine and
lists what is missing; each step installs one thing:

| Runtime    | Checks                                                      | Installs                        |
| ---------- | ----------------------------------------------------------- | ------------------------------- |
| smol       | The engine runs here; warns on no `/dev/kvm` or `resize2fs` | smolvm, the smolmachines engine |
| lume       | None                                                        | Lume 0.6.1                      |
| bare_metal | An `sshd` binary; sshd's StrictModes on amikad's state      | amikad                          |

- A check that fails refuses setup before anything is stored.
- smolvm is `DEFAULT_SMOLVM_VERSION`, or `AMIKA_HOSTD_SMOLVM_VERSION`
  (`latest` for the newest). Its own installer puts it in `~/.smolvm`.
- The engine is the archive `engines.sha256` pins for this platform. Setup
  downloads it from npm (`AMIKA_HOSTD_NPM_REGISTRY`), checks its sha256,
  and unpacks it into `node_modules/` beside the bundle. A bundle run from
  a checkout has no `engines.sha256`, so setup skips the engine.
- StrictModes needs every directory above amikad's state directory owned by
  root or the hostd account, and not group- or world-writable. Setup names
  the directory and the `chmod` that fixes it (`src/internal/strict-modes.ts`).
- With bare_metal on, setup prints the resources it detected and the
  account that SSH logs in as.

Setup does not build the macOS image a Lume preset boots: that takes 30
minutes or more. The daemon builds it in the background once it starts,
and refuses macOS rigs until it is done (see
[Building the template](runtime.md#building-the-template)). Setup says so.

### Writing the config

It then writes `hostname` in place (a live line, bare or quoted, else the
commented `# hostname = ...` one; otherwise above the first table), keeping
everything else in the file. With the file store it writes `secret_key` the
same way, except that a setting with no line of its own goes under the
`hostname` line; so does `secret_store`. With the keychain it removes any
`secret_key` line instead, moving that secret into the keychain if the
keychain has none (the keychain's own item wins otherwise). A `secret_key` too
short to use, such as an old example's `REPLACE_ME`, counts as unset. A config
written from scratch also gets the example's default `[sizes]` and
`[presets.*]` (`DEFAULT_SIZES` and `DEFAULT_PRESET_IMAGES`, which
`setup.test.ts` keeps in step with `config.example.toml`). It prints the
result and where to edit it. The new contents are parsed before anything is
written, and the file is replaced atomically with mode `0600`
(`src/internal/private-file.ts`). The secrets are stored first, so a secret
that cannot be stored (a locked keychain, say) leaves the config untouched.

Registration never changes a stored secret, so setup sends a regenerated
secret key to Amika (register, then `PUT /api/v0beta1/hosts/{id}` with
`secret`, `setHostSecret`) for the hostname it writes, which may be new or one
Amika already knows. It stores the new key and writes the config first, so a
key this host could not keep never reaches Amika. If any of these steps fails,
it puts the old key back where it keeps it (the keychain item, or `secret_key`
in the file) and says how to recover in case Amika applied the new one anyway;
if the old key cannot be put back, it says the new one stayed. Ctrl-C while
Amika is answering counts as such a failure: a SIGINT listener, set only for
the request, cancels it, so the old key goes back instead of the process
ending mid-request. A new API key entered in the same run is saved only once
Amika has taken the new secret key with it, so one Amika refuses (a typo, say)
is not kept for the next run. Setup does not offer to regenerate while the
environment overrides the secret key, hostname, API URL or API key: the new
key would reach the Amika, organization or hostname this run reaches, while
`up` goes back to the stored ones once the override is unset, and the daemon
would keep using an overriding secret key. After regenerating, setup says to
restart a running daemon, which keeps the key `up` handed it.

### Without a terminal

`amika-hostd setup --non-interactive` asks nothing, for an AI agent or a
script. It runs the same setup, and gives each question its default:

- the hostname from `--hostname`, else the configured one or this machine's
- the configured runtimes, changed by `--enable <runtime>` and
  `--disable <runtime>`, with the same installs
- no to every other yes/no question, so it never regenerates or replaces a
  secret key
- the API key from stdin, when none is stored or set in the environment

An answer setup refuses (an invalid hostname, no API key on stdin) stops it
with nothing changed.

### The setup skill

`amika-hostd setup --skill` prints a SKILL.md document
(`src/internal/setup-skill.ts`). It tells an agent to:

1. Agree the hostname with the operator.
2. Keep the tunnel transport, unless the operator wants to expose a port.
3. Ask the operator about each runtime this machine can run, with what each
   installs, before setup installs anything.
4. Get an API key: user-scoped for a tunnelled host. Make it with
   `amika auth api-key create --out <file>` when the `amika` CLI is signed
   in, else get it from the operator. Pipe the file into
   `setup --non-interactive`, with the runtime flags.
5. Use the file store only with the operator's consent, when there is no
   keychain.
6. Run `up`, then `register-url` for a listening host.

The skill needs no terminal and no valid config. It fills in the config and
log paths, the daemon's local address, and the runtimes this machine can
run. The install script points agents at it.

`setup-skill.test.ts` parses each `amika-hostd` command in the skill with
the CLI's parser. Update the text by hand when an error message or
environment variable it names changes, or an option of
`amika auth api-key create`.

`up` runs setup first whenever the hostname, secret key or API key is
missing, or the file still holds a `secret_key` while secrets are kept in the
keychain, and it has a terminal; without one it fails, naming `setup`, or,
when another secret key is in effect (the keychain's, or the environment's),
warns that the file's is unused and carries on. Like setup, it reads a
`secret_key` too short to use as missing, so a hand-copied old example gets
set up rather than rejected; other commands still reject it. Ctrl-C at a
question exits 130 and changes nothing.

## Secret storage

hostd has two secrets: the Amika API key, which `up` and `register-url` use
to call Amika, and the secret key, which Amika presents on every request to
the daemon. `src/internal/credentials.ts` keeps both in one of two stores,
chosen by `secret_store` in the TOML file or `AMIKA_HOSTD_SECRET_STORE`:

- **`keychain`** (the default, `DEFAULT_SECRET_STORE`): both are items in
  the system keychain. On macOS that is the login keychain, through `security` (service
  `amika-hostd`, one account per secret: `api-key`, `secret-key`), named
  explicitly in every command (from `security login-keychain`), since
  without one `security` uses the default keychain, which a user can change
  to another, separately locked or temporary, one. Values go
  in through `security -i` on stdin, so they never appear in the process
  list, and are read back to confirm they were stored. Exit 44 means "not
  there"; any other failure (a locked keychain, over SSH say) is an error
  that says to unlock it or choose files. On a Linux desktop session
  (`DBUS_SESSION_BUS_ADDRESS` set and not blank) it is the Secret Service
  (GNOME Keyring, KWallet), through `secret-tool`, which takes values on
  stdin; items carry `service=amika-hostd` and `account=<secret>`.
  `secret-tool lookup` exits 1 silently both for no item and for a locked one
  whose unlock prompt was dismissed, so a silent exit 1 is confirmed with
  `secret-tool search --all` (which lists locked items without unlocking
  them on GNOME Keyring and KWallet, and whose output is never shown): an
  item there is refused as locked. KeePassXC hides a locked database's items
  from the search too, so setup also asks before generating a new secret key
  when config.toml has the `secret_store = "keychain"` setup wrote but the
  keychain shows no secret key, and changes nothing on "no". Any other
  failure is an error quoting secret-tool's stderr; a session bus with no
  keyring daemon on it, as over SSH to a server, says to choose files rather
  than to unlock anything. On a machine where amika-hostd supports no
  keychain (Linux with no desktop or user session, so no
  `DBUS_SESSION_BUS_ADDRESS`), every command that needs a secret refuses,
  naming `secret_store = "file"`; it never falls back to a file on its own.
  A bus GLib could find without that variable (under `sudo -u`, say) is not
  used.
- **`file`**, chosen explicitly: the API key in
  `$XDG_CONFIG_HOME/amika-hostd/api-key` and the secret key as `secret_key` in
  the TOML file, both mode `0600`. That is how `gh` and Docker keep
  credentials without a keyring, and how WireGuard and `sshd` keep their keys.

The two are never mixed: a read never falls back from one store to the other,
so a key left in one cannot shadow a newer one in the other. The environment
(`AMIKA_HOSTD_API_KEY`, `AMIKA_HOSTD_SECRET_KEY`) overrides either store, and
the store is opened only for a secret the environment does not set, so a
command whose secrets are all exported runs on a machine with no keychain.
Setup is the exception: it stores secrets, so it always opens the store. When
setup generates a secret key for a host that already has a hostname, it warns
that Amika may still hold the one the host first registered with.

A person always starts the daemon, with `up`, so `up` reads the secrets (an
unlock prompt can reach them) and hands the secret key to the background
daemon over the IPC channel it already uses to wait for "ready"
(`receiveSecretKey` in `src/internal/daemon.ts`, behind the internal
`serve --secret-key-from-up`, which reads the file as `up` does, so a
placeholder `secret_key` there cannot stop it). Neither secret goes in the
daemon's environment, and the daemon never reads the store; smolvm and rigs get
neither. `serve` run by hand reads the secret key from the store itself, and
never the API key.

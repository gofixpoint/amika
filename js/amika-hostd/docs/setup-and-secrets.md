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
may be in a keychain that is only locked. (The hostname is no such mark: the
installer seeds it.) When the environment chooses a store
(`AMIKA_HOSTD_SECRET_STORE`) other than the one the file alone would (its
`secret_store`, else the keychain default), setup writes `secret_store` to
match where it kept the secrets, so the choice outlasts the variable, and says
so when it replaces a different one. An existing secret key is kept, but on a
rerun setup asks whether to regenerate it. Then it asks for the Amika API key,
with input hidden, or on a rerun whether to replace the stored one; an API key
in the environment is used instead, and setup does not ask. Before the prompt
it names the page that creates one, `/settings/api-keys` on the configured
API URL's origin.

It then writes `hostname` in place (a live line, bare or quoted, else the
commented `# hostname = ...` one; otherwise above the first table), keeping
everything else in the file. With the file store it writes `secret_key` the
same way, except that a setting with no line of its own goes under the
`hostname` line; so does `secret_store`. With the keychain it removes any
`secret_key` line instead, moving that secret into the keychain if the
keychain has none (the keychain's own item wins otherwise). A `secret_key` too
short to use, such as an old example's `REPLACE_ME`, counts as unset. A config
written from scratch also gets the example's default `[sizes]` and
`[preset_images]` (`DEFAULT_SIZES` and `DEFAULT_PRESET_IMAGES`, which
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

`amika-hostd setup --non-interactive` asks nothing, for an AI agent or a
script. It runs the same setup, answering each question with its default: the
hostname from `--hostname`, else the configured one or this machine's; no to
every yes/no question, so it never regenerates or replaces a secret key; and
the API key from stdin when none is stored or set in the environment. An
answer setup refuses (an invalid hostname, no API key on stdin) ends it with
nothing changed, instead of asking again.

`amika-hostd setup --skill` prints, as a SKILL.md document, how an agent sets
the host up with it: settle the hostname with the operator, get an API key
(minted by `amika auth api-key create --out <file>` when the `amika` CLI is
logged in, else from the operator) and pipe it from that file into
`setup --non-interactive`, choose the file store only with the operator's
consent when there is no keychain, then run `up` and `register-url`
(`src/internal/setup-skill.ts`). It needs no terminal or valid config, and
fills in the config and log files and the daemon's local address (from `host`
and `port`, loopback for a wildcard bind). The installer points agents at it.
`setup-skill.test.ts` checks that every command and option it uses exists and
every variable it names is one the config reads, so keep them in step when the
CLI changes. Options on `amika` CLI commands are exempt from that check, so a
change to `amika auth api-key create` must be mirrored in the skill text by hand.

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

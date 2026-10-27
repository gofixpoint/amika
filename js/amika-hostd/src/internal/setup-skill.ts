/**
 * What `amika-hostd setup --skill` prints: how an AI agent sets this machine
 * up as an Amika host. An agent cannot answer `setup`'s prompts (they need a
 * terminal, and the API key prompt hides its input), so the steps run
 * `setup --non-interactive` instead. It is a SKILL.md document, so an agent
 * can also save it as a skill.
 */

/** What the instructions name, as this host resolves it. */
export interface SkillContext {
  /** The TOML file `up` reads, or would create. */
  configPath: string;
  /** The background daemon's log. */
  logFile: string;
  /** Where the daemon listens, as a URL this machine can reach. */
  localUrl: string;
}

export function setupSkill({
  configPath,
  logFile,
  localUrl,
}: SkillContext): string {
  return `---
name: amika-hostd-setup
description: Set up this machine as an Amika host with amika-hostd, without interactive prompts. Use when asked to set up, register, or start amika-hostd, or to connect this machine to Amika so rigs can run on it.
---

# Set up amika-hostd without prompts

\`amika-hostd setup\` asks its questions in a terminal, so run
\`amika-hostd setup --non-interactive\` instead. It asks nothing: it keeps
whatever is already set up, generates this host's secret key if there is
none, and writes the config with default rig sizes and images:

    ${configPath}

Never print the secret key or the Amika API key, paste them into chat, or
put them in a command line, a file in the repository, or a log.

## 1. Hostname

This host's name in the operator's Amika organization: lowercase letters,
digits, and hyphens, in dot-separated labels. The config may hold the
secret key, so never \`cat\` it; read only the lines you need:

    grep -E '^\\s*(hostname|transport)\\s*=' ${shellQuote(configPath)}

If the config has a \`hostname\` (the installer fills in this machine's
name), keep it: changing it registers a new host. Otherwise ask the operator
what to call this host, suggesting this machine's own name, lowercased
(\`hostname\`).

## 2. How Amika reaches the host

There are two transports:

- **Tunnel**, the default: the daemon dials out to Amika's gateway and binds
  no port. Nothing is exposed and there is no URL to register, so it works
  behind a home router or a firewall that allows outbound HTTPS. It needs a
  user-scoped API key (step 3).
- **Listen**: the daemon binds ${localUrl}, and the operator exposes that
  port to the internet over HTTPS themselves (ngrok, Cloudflare Tunnel, a
  port forward), then registers the public URL with Amika (step 5).

\`AMIKA_HOSTD_TRANSPORT\`, if set, beats the config's \`transport\` line,
which beats the default. Choose listen if any of these hold:

- the operator asked to expose a port themselves;
- \`AMIKA_HOSTD_TRANSPORT\` is \`listen\`;
- the config has \`transport = "listen"\`;
- the config has no \`transport\` line, \`amika host get <hostname>\` shows
  \`Transport: listen\`, and the operator wants to keep it that way. Ask
  them: without the line, the next \`up\` moves the host to the tunnel and
  drops its URL. (A host Amika has never seen, or no \`amika\` CLI to check
  with, means there is nothing to keep.)

Otherwise use the tunnel, and do not ask.

## 3. Run setup

Setup needs the operator's Amika API key the first time, and stores it. If
\`AMIKA_API_KEY\` or \`AMIKA_HOSTD_API_KEY\` is already set in your
environment, setup and \`up\` use it and nothing needs passing, but it is
not stored, so keep it set for \`up\` and \`register-url\`. If setup stored a
key on an earlier run, it keeps that one, and nothing needs passing either.

So first run setup with nothing on its input:

    amika-hostd setup --non-interactive --hostname <name> < /dev/null

If that succeeds, setup has a key; go on to "Set the transport" below. Only
if it fails with "pipe the Amika API key into
\`amika-hostd setup --non-interactive\`" does it need one (it changed
nothing). Do not make a key otherwise: setup would keep the key it has and
ignore the new one, leaving it unused in the organization. For any other
failure, see the list below.

The key goes in through a file you never read. Make a private
directory for it with \`mktemp -d\`. It gets a new random name that only the
operator can enter, so no one else can create it first or read what goes in
it. It prints the directory's path, which is not secret: note it, and use it
literally as \`<dir>\` below, since a shell variable may not survive between
your commands.

    mktemp -d

Then fill \`<dir>/api-key\` one of two ways. The key's scope depends on the
transport: a tunnelled host needs a user-scoped key, because Amika enrols
a host with its gateway only for a person. A listening host should get an
organization-scoped key, which keeps working if the person who made it
leaves.

- **With the \`amika\` CLI**, if it is installed and \`amika auth status\`
  reports it authenticated. It writes the key to the file with mode 0600.
  For a tunnelled host:

      amika auth api-key create --name <name>-hostd --scope user --out <dir>/api-key

  For a listening host:

      amika auth api-key create --name <name>-hostd --out <dir>/api-key

  A CLI signed in with an organization key cannot make a user-scoped one;
  if that fails, make the key by hand instead.
- **By hand** otherwise. Create the file empty
  (\`install -m 600 /dev/null <dir>/api-key\`), then ask the operator to
  create an API key with the scope above in the Amika web app, at
  \`/settings/api-keys\` on the \`api_url\` this host uses
  (https://app.amika.dev/settings/api-keys by default), paste it into that
  file (give them the full path) in an editor, save, and tell you when they
  are done. Check it is not empty with \`test -s\`, which does not read it.

Pipe the file straight into setup:

    amika-hostd setup --non-interactive --hostname <name> < <dir>/api-key

Delete the directory once setup succeeds, or when you stop trying:

    rm -rf <dir>

Never \`cat\`, open, copy, or otherwise read that file yourself; only
redirect it into \`amika-hostd setup\`.

Once a key is stored, setup keeps it: only the operator can replace it, by
running \`amika-hostd setup\` in a terminal.

If setup says:

- **"No keychain on this machine", "nowhere to keep its secrets", or
  "secret-tool is not installed"**: secrets are kept in the system keychain
  by default, and this machine has none it can use (a server without a
  desktop session, say). Do not unlock or install anything, and do not
  follow the message's own hint on your own: ask the operator whether to
  keep the secrets in files only they can read instead. If they agree, run
  setup again with \`AMIKA_HOSTD_SECRET_STORE=file\` before the command;
  setup records the choice in the config.
- **it cannot read the keychain, or "No secret key found"**: the keychain
  may be locked. Ask the operator to unlock it, then run setup again. Do not
  work around it: replacing a secret key Amika already has locks Amika out.

Setup never changes an existing secret key here. Only the operator should,
by running \`amika-hostd setup\` in a terminal and choosing to regenerate it.

### Set the transport

For the tunnel, there is nothing to do unless \`AMIKA_HOSTD_TRANSPORT\` or
the config says \`listen\`; then ask the operator before changing it.

To listen, replace any \`transport =\` line in the config (commented out
or not) with this one, or add it above the first \`[\` line:

    transport = "listen"

If \`AMIKA_HOSTD_TRANSPORT\` is set to \`tunnel\`, it overrides that line:
tell the operator.

## 4. Start the daemon

    amika-hostd up

Without a terminal \`up\` asks nothing. It registers the host with Amika and
starts the daemon and smolvm in the background. A tunnelled host enrols
with Amika's gateway and connects out to it. A listening host binds a port
(${localUrl} by this host's config) and prints the local address; if it
differs, use the printed one below. If \`up\` fails with "Missing required
configuration", step 3 is not done; the message names what is missing.

If it fails with:

- **\`real_user_required\`** ("refused to enrol this host for tunnel
  mode"): the key is organization-scoped, and a tunnelled host needs a
  user-scoped one. If \`AMIKA_API_KEY\` or \`AMIKA_HOSTD_API_KEY\` is set,
  that is the key: ask the operator to unset it or set a user-scoped key
  there. Otherwise ask them to replace the stored key by running
  \`amika-hostd setup\` in a terminal.
- **\`host_tunnel_not_enabled\`**: this Amika deployment has no tunnel.
  Tell the operator, and offer to listen instead (step 2).
- **\`byoc_not_activated\`**: the organization has not activated its own
  hosts. Tell the operator to enter their activation code in the Amika web
  app, under **Your hosts** in the create-rig form.

## 5. Make the host reachable

If \`up\` printed "Amika assigns this host's address", skip to step 6:
there is nothing to expose or register, and \`register-url\` is refused.

Otherwise the host is a listener, which Amika reaches over the internet. If
\`up\` printed "To complete registration", expose the daemon's local address
with an HTTPS tunnel the operator approves, such as
\`ngrok http ${localUrl}\` or \`cloudflared tunnel --url ${localUrl}\`, then
give Amika the tunnel's public URL:

    amika-hostd register-url https://<public-url>

If \`up\` said instead that Amika reaches the host at a URL, make sure that
URL still forwards to the daemon.

## 6. Check it works

- \`amika-hostd status\` says whether the daemon is running: it exits 0 if
  so and 3 if not.
- The daemon's log: ${logFile}
- With the \`amika\` CLI signed in to the same organization,
  \`amika host get <hostname>\` shows the host, its transport and its URL. A
  tunnelled host shows no URL; Amika assigns its address.

## Stopping

    amika-hostd down

stops the daemon, and smolvm with it, which stops every rig on this host.
`;
}

/** `path` as one shell word. */
function shellQuote(path: string): string {
  return /^[\w@%+=:,./-]+$/.test(path)
    ? path
    : `'${path.replaceAll("'", `'\\''`)}'`;
}

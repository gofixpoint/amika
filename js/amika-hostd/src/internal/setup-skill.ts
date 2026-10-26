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
digits, and hyphens, in dot-separated labels. If the config already has a
\`hostname\`, keep it (changing it registers a new host). Otherwise ask the
operator what to call this host, suggesting this machine's own name,
lowercased (\`hostname\`).

## 2. How Amika reaches the host

The config's \`transport\` setting decides it, one of two ways:

- **Tunnel**, the default: the daemon dials out to Amika's gateway and binds
  no port. Nothing is exposed and there is no URL to register, so it works
  behind a home router or a firewall that allows outbound HTTPS. It needs a
  user-scoped API key (step 3).
- **Listen**: the daemon binds ${localUrl}, and the operator exposes that
  port to the internet over HTTPS themselves (ngrok, Cloudflare Tunnel, a
  port forward), then registers the public URL with Amika (step 5).

Use the tunnel unless the operator asked to expose a port themselves, or
the config already has \`transport = "listen"\`; do not ask them to choose
otherwise. Check the config first: a host set up before the tunnel was the
default has no \`transport\` line, and if \`amika host get <hostname>\`
shows it with a URL, it is a listener today. Its next \`up\` moves it to the
tunnel and drops that URL, so ask the operator which they want before
starting it.

To listen, once setup has written the config in step 3, add this line to it
with the other top-level settings, above the first \`[\` table:

    transport = "listen"

## 3. Run setup

Setup needs the operator's Amika API key the first time, and stores it. If
\`AMIKA_API_KEY\` or \`AMIKA_HOSTD_API_KEY\` is already set in your
environment, setup and \`up\` use it and nothing needs passing, but it is
not stored, so keep it set for \`up\` and \`register-url\`. If setup stored a
key on an earlier run, it keeps that one, and nothing needs passing either.

So first run setup with nothing on its input:

    amika-hostd setup --non-interactive --hostname <name> < /dev/null

If that succeeds, setup has a key; go on to step 4. Only if it fails with
"pipe the Amika API key into \`amika-hostd setup --non-interactive\`" does it
need one (it changed nothing). Do not make a key otherwise: setup would
keep the key it has and ignore the new one, leaving it unused in the
organization. For any other failure, see the list below.

The key goes in through a file you never read. Make a private
directory for it with \`mktemp -d\`. It gets a new random name that only the
operator can enter, so no one else can create it first or read what goes in
it. It prints the directory's path, which is not secret: note it, and use it
literally as \`<dir>\` below, since a shell variable may not survive between
your commands.

    mktemp -d

Then fill \`<dir>/api-key\` one of two ways:

- **With the \`amika\` CLI**, if it is installed and \`amika auth status\`
  reports it authenticated. It writes the key to the file with mode 0600:

      amika auth api-key create --name <name>-hostd --scope user --out <dir>/api-key

  Use user scope, not the CLI's default organization scope: a tunnelled
  host enrols with Amika's gateway using the key, and Amika enrols a host
  only for a person. A listening host does not enrol, so for one keep the
  organization scope: a host belongs to the organization, so its key should
  keep working when the person who set it up leaves.

      amika auth api-key create --name <name>-hostd --out <dir>/api-key
- **By hand** otherwise. Create the file empty
  (\`install -m 600 /dev/null <dir>/api-key\`), then ask the operator to
  create an API key in the Amika web app, at \`/settings/api-keys\` on the
  \`api_url\` this host uses (https://app.amika.dev/settings/api-keys by
  default), with user scope for a tunnelled host and organization scope for
  a listening one, paste it into that file (give them the full path) in an
  editor, save, and tell you when they are done. Check it is not empty with
  \`test -s\`, which does not read it.

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
  keep the secrets in files only they can read instead. If they agree, run setup again with
  \`AMIKA_HOSTD_SECRET_STORE=file\` before the command; setup records the
  choice in the config.
- **it cannot read the keychain, or "No secret key found"**: the keychain
  may be locked. Ask the operator to unlock it, then run setup again. Do not
  work around it: replacing a secret key Amika already has locks Amika out.

Setup never changes an existing secret key here. Only the operator should,
by running \`amika-hostd setup\` in a terminal and choosing to regenerate it.

## 4. Start the daemon

    amika-hostd up

Without a terminal \`up\` asks nothing. It registers the host with Amika,
starts the daemon and smolvm in the background, and, for a tunnelled host,
enrols it with Amika's gateway and connects out to it, binding no port. A
listening host binds one instead, and \`up\` reports it: by this host's
config the daemon is at ${localUrl}; if \`up\` reports another port (a
\`--port\` flag, or \`AMIKA_HOSTD_PORT\`), use that instead below. If it fails
with "Missing required configuration", step 3 is not done; the message names
what is missing. For a tunnelled host, if it says:

- **"refused to enrol this host for tunnel mode" with \`real_user_required\`**:
  the stored key is organization-scoped. Ask the operator to replace it with
  a user-scoped one by running \`amika-hostd setup\` in a terminal.
- **\`host_tunnel_not_enabled\`**: this Amika deployment, or the operator's
  organization, does not have the tunnel turned on. Tell the operator, and
  offer to listen instead (step 2).

## 5. Make the host reachable

If \`up\` said Amika assigns this host's address, as it does for a tunnelled
host, there is nothing to do here:
Amika reaches such a host over its own gateway, there is no URL to give it,
and \`register-url\` on one is refused. Whether Amika can reach it yet is
Amika's to report, not this daemon's. Skip to step 6.

Otherwise the host is a listener, which Amika reaches over the internet. If
\`up\` printed "To complete registration", expose the daemon's local address
with an HTTPS tunnel the operator approves, such as
\`ngrok http ${localUrl}\` or \`cloudflared tunnel --url ${localUrl}\`, then
give Amika the tunnel's public URL:

    amika-hostd register-url https://<public-url>

If \`up\` said instead that Amika reaches the host at a URL, make sure that
URL still forwards to the daemon.

## 6. Check it works

- The daemon's log: ${logFile}
- With the \`amika\` CLI signed in to the same organization,
  \`amika host get <hostname>\` shows the host, its transport and its URL. A
  tunnelled host shows no URL; Amika assigns its address.

## Stopping

    amika-hostd down

stops the daemon, and smolvm with it, which stops every rig on this host.
`;
}

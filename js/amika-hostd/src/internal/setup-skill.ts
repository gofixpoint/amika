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
  const port = new URL(localUrl).port || "80";
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

## 2. Run setup

Setup needs the operator's Amika API key the first time, and stores it. If
\`AMIKA_API_KEY\` or \`AMIKA_HOSTD_API_KEY\` is already set in your
environment, setup and \`up\` use it and nothing needs passing, but it is
not stored, so keep it set for \`up\` and \`register-url\`. Otherwise ask the
operator to save the key in a file only they can read, and pipe it in (the
operator deletes the file afterwards):

    amika-hostd setup --non-interactive --hostname <name> < /path/to/key-file

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

## 3. Start the daemon

    amika-hostd up

Without a terminal \`up\` asks nothing. It registers the host with Amika,
starts the daemon and smolvm in the background, and reports the port it
listens on. By this host's config the daemon is at ${localUrl}; if \`up\`
reports another port (a \`--port\` flag, or \`AMIKA_HOSTD_PORT\`), use that
instead below. If it fails with "Missing required configuration", step 2 is
not done; the message names what is missing.

## 4. Make the host reachable

Amika reaches the host over the internet. If \`up\` printed "To complete
registration", expose the daemon's local address with an HTTPS tunnel the
operator approves, such as \`ngrok http ${port}\` or
\`cloudflared tunnel --url ${localUrl}\`, then give Amika the tunnel's
public URL:

    amika-hostd register-url https://<public-url>

If \`up\` said instead that Amika reaches the host at a URL, make sure that
URL still forwards to the daemon.

## 5. Check it works

- The daemon's log: ${logFile}
- With the \`amika\` CLI signed in to the same organization,
  \`amika host get <hostname>\` shows the host and its URL.

## Stopping

    amika-hostd down

stops the daemon, and smolvm with it, which stops every rig on this host.
`;
}

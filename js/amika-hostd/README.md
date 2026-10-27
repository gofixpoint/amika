# amika-hostd

Bring your own compute (BYOC): run Amika Rigs on your own machines.

`amika-hostd` is a daemon you install on a machine you control. It registers
that machine with the Amika control plane as a _host_, and runs each Rig on it
as a local VM. You keep using the same `amika` CLI and web UI: a Rig created
with `--host <hostname>` runs on your hardware instead of Amika Cloud.

The VMs and their disks stay on your machine. The daemon dials out to Amika's
gateway, so the machine needs no open port: it works behind a home router.
Creating and managing a rig goes through Amika, which authenticates the request
and forwards it down that connection to your daemon. If you would rather expose
a port yourself, through ngrok or Cloudflare Tunnel, the daemon can
[listen on one](#listening-on-a-port) instead.

## Requirements

- Linux x86_64 or arm64 with glibc 2.34+ and KVM, or macOS on Apple silicon
- `e2fsprogs`, only if a rig size has a disk under 20 GiB: smolvm shrinks its
  template with `resize2fs`
- Outbound HTTPS from the machine to Amika. A [listening](#listening-on-a-port)
  host also needs a way to expose a port to the internet.
- A user-scoped Amika API key, from **Settings → API keys** at
  [app.amika.dev](https://app.amika.dev/settings/api-keys). Amika hands a
  host the credential for its gateway only for a person, so an
  organization-scoped key is refused. A [listening](#listening-on-a-port)
  host can use either, and is better off with an organization key, which
  outlives the person who made it.

Node.js and [smolvm](https://smolmachines.com) are installed for you if the
machine doesn't have them.

## Run a BYOC rig

### 1. Install the daemon on your host

```bash
curl -fsSL https://raw.githubusercontent.com/gofixpoint/amika/main/install-amika-hostd.sh | sh
```

[Installation](docs/installation.md) lists what the installer puts where, its
options, and how `--uninstall` removes it again.

### 2. Set up credentials

```bash
amika-hostd setup
```

It asks for the host's name and your Amika API key, and generates the secret
key the control plane uses to reach this daemon. Secrets go in the system
keychain. On a server with no keychain, set `secret_store = "file"` in the
config first. Edit the file the installer printed: the daemon reads
`$XDG_CONFIG_HOME/amika-hostd/config.toml` (`~/.config/...` by default) if it
exists and `/etc/amika-hostd/config.toml` otherwise, never both.
[Setup and secret storage](docs/setup-and-secrets.md) covers what setup asks,
`setup --non-interactive` for scripts, and how each store keeps the secrets.

To have an AI agent set up the host, point it at `amika-hostd setup --skill`.
That prints step-by-step instructions it can follow without prompts, including
whether to use the gateway or listen on a port, and how to get the API key
without seeing it.

### 3. Start it

```bash
amika-hostd up
amika-hostd status   # is the daemon up? exits 0 if so, 3 if not
```

This registers the host with Amika, enrols it with Amika's gateway, starts the
daemon connected to that gateway, and starts smolvm alongside it. Amika assigns
the host's address; there is no URL to give it.

To expose a port yourself instead, see
[Listening on a port](#listening-on-a-port).

### 4. Create a rig on the host

```bash
amika host list                                       # confirm it registered
amika rig create dev-box --host <hostname> --size small
```

The first `up` downloads the preset images in the background, and a rig created
before that finishes can time out. `up` says so, and logs the progress.

In the web UI, pick **Your hosts** in the create-rig panel, then the host.

### 5. Stop the host

```bash
amika-hostd down
```

Stops the daemon and the VMs it is running, keeping their disks. The next `up`
brings the daemon back, but not the rigs: start those with `amika rig start`.

## Listening on a port

A daemon can instead bind `127.0.0.1:3020` and let you expose it, through
[ngrok](https://ngrok.com) or
[Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/),
say. Set `transport = "listen"` in the config, above its first `[` line (or
set `AMIKA_HOSTD_TRANSPORT=listen`, which overrides the config), run
`amika-hostd up`, then tell Amika where to find it:

```bash
ngrok http 3020                                    # in another terminal
amika-hostd register-url https://<your-tunnel-url> # the URL ngrok printed
```

`amika-hostd up` prompts for this URL when the host doesn't have one yet, so
you can paste it there instead. Prefer HTTPS at the root of its own hostname on
the default port, as a tunnel URL gives. `register-url` takes a path, an
explicit port or plain http and warns: rigs and service tokens still work, but
browsers cannot open the host's previews, since a browser logs in to a preview
with a cookie that needs the host's own https origin. Browser previews and
`rig ssh` reach a listening daemon directly, on a credential Amika signed, so
do not restrict the tunnel to Amika's own traffic.

A host set up before the gateway was the default, whose config has no
`transport` line, moves to the gateway on its next `up`, which drops its
registered URL. Add `transport = "listen"` to keep it listening.

## Configuration

The config file from step 2 sets the hostname, how Amika reaches the host, the
rig sizes this host offers, and the preset images it boots. Every `up`
publishes the sizes to Amika, so the file is the source of truth for them.
Preset images stay local: this host pins the version it boots. Edit the file
and restart the daemon either way.

See `config.example.toml` for every key, and
[Configuration](docs/configuration.md) for each setting's environment variable,
preset images, and the image cache.

## Managing hosts

| Command                        | What it does                                   |
| ------------------------------ | ---------------------------------------------- |
| `amika host list`              | List your organization's hosts and their sizes |
| `amika host get <hostname>`    | Show one host and the sizes it offers          |
| `amika host delete <hostname>` | Delete a host and its stored secret            |

Hosts register themselves, so there is no `amika host add`. Deleting a host
leaves the machine alone: run `amika-hostd down` there, or it registers again
on the next `up`.

## Links

- [BYOC guide](https://docs.amika.dev/guides/byoc)
- [`amika host` reference](https://docs.amika.dev/reference/cli)
- [AGENTS.md](./AGENTS.md) for how the daemon works internally, with an index
  of the detail docs in [`docs/`](./docs/)

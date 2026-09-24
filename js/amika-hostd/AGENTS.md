# Amika host daemon

`@amika/hostd` is a standalone Node.js service built with Hono. It will manage
local VMs and make them accessible through the Amika control plane. The current
skeleton only provides `GET /health`, returning `{ "status": "ok" }`.
VM lifecycle management and control-plane integration belong in subsequent PRs.

## Development

Run commands from the monorepo root:

```bash
pnpm install
pnpm --filter @amika/hostd dev
```

The server defaults to `127.0.0.1:3020`. No external services or credentials
are required to serve locally.

```bash
curl http://127.0.0.1:3020/health
pnpm --filter @amika/hostd build
pnpm --filter @amika/hostd start
```

## Configuration

`src/internal/config.ts` resolves every setting in one place. Each setting takes
the first source that sets it: CLI flag, then environment, then TOML file.

| Setting    | Flag     | Environment                                   | TOML         | Default                 |
| ---------- | -------- | --------------------------------------------- | ------------ | ----------------------- |
| API key    |          | `AMIKA_HOSTD_API_KEY` / `AMIKA_API_KEY`       | (rejected)   | required for Amika APIs |
| API URL    |          | `AMIKA_HOSTD_API_URL` / `AMIKA_API_URL`       | `api_url`    | `https://app.amika.dev` |
| Hostname   |          | `AMIKA_HOSTD_HOSTNAME`                        | `hostname`   |                         |
| Secret key |          | `AMIKA_HOSTD_SECRET_KEY` / `AMIKA_SECRET_KEY` | `secret_key` |                         |
| Bind host  | `--host` | `AMIKA_HOSTD_HOST`                            | `host`       | `127.0.0.1`             |
| Port       | `--port` | `AMIKA_HOSTD_PORT`                            | `port`       | `3020`                  |

Setting both names of an aliased pair to different values is an error, never a
silent pick. The API key is environment-only: a TOML `api_key` fails startup.
The hostname must be a lowercase RFC 1123 hostname, the rule the control plane
enforces, so a bad one fails locally instead of at registration.
The TOML file is the first of `$XDG_CONFIG_HOME/amika-hostd/config.toml`
(default `~/.config/...`) and `/etc/amika-hostd/config.toml` that exists; the
two are not merged, and unknown keys are rejected. `SMOL_API_URL` and
`SMOL_REQUEST_TIMEOUT_MS` remain environment-only. Never include a secret or
file contents in a `ConfigError` message: operators see it verbatim.

## Checks

```bash
pnpm --filter @amika/hostd formatcheck
pnpm --filter @amika/hostd typecheck
pnpm --filter @amika/hostd lint
pnpm --filter @amika/hostd test
```

The test command allows an empty suite until behavior is added. Use `format` to
apply formatting. `src/app.ts` defines routes without opening a socket;
`src/index.ts` handles configuration, listening, and shutdown.

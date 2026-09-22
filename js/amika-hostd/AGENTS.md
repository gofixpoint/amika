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

The server defaults to `127.0.0.1:3020`. Override `HOST` and `PORT` through the
environment. No external services or credentials are required.

```bash
curl http://127.0.0.1:3020/health
pnpm --filter @amika/hostd build
pnpm --filter @amika/hostd start
```

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

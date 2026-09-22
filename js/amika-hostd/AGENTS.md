# Amika host daemon

`@amika/hostd` is a standalone Node.js service built with Hono. It exposes
local Smol machine lifecycle, exec, and file operations over HTTP.
Authentication is not implemented yet.

## Development

Run commands from the monorepo root:

```bash
pnpm install
pnpm --filter @amika/hostd dev
```

The server defaults to `127.0.0.1:3020`. Override `HOST` and `PORT` through the
environment. Machine operations require a separately running `smolvm serve`;
`SMOL_API_URL` defaults to `http://127.0.0.1:8080`. Health checks do not contact
the runtime. No credentials are required.

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

Tests inject the runtime HTTP transport and require no VMs. Use `format` to
apply formatting. `src/app.ts` defines routes without opening a socket;
`src/index.ts` handles configuration, listening, and shutdown.

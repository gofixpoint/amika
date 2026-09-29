/** HTTP surface for the local VM host daemon. */
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { requireSecretKey } from "./internal/auth.js";
import { SmolRuntime, type SmolRuntimeConfig } from "./internal/smol.js";
import {
  createMachineSchema,
  execSchema,
  filePath,
  machinePath,
  resolveImage,
} from "./internal/requests.js";
import {
  SERVICES_PREFIX,
  freeLoopbackPort,
  parseServicePath,
  resolveHostPort,
  stripHopByHopHeaders,
  verifyServiceToken,
} from "./internal/services.js";

export interface AppConfig extends SmolRuntimeConfig {
  /**
   * Every request except the signed `/services/...` routes, including
   * `/health`, must present this as a bearer token.
   */
  secretKey: string;
  /** Preset image names mapped to the OCI references smolvm boots. */
  images?: Record<string, string>;
  /** Named in errors for unconfigured images, so operators know what to edit. */
  configPath?: string;
}

export interface AppDeps {
  /** Picks the host loopback port smolvm publishes a guest port on. */
  allocatePort?: () => Promise<number>;
}

/** Build routes without opening a socket; the runtime transport is injectable. */
export function createApp(
  { secretKey, images = {}, configPath, ...runtimeConfig }: AppConfig,
  fetcher = fetch,
  { allocatePort = freeLoopbackPort }: AppDeps = {},
) {
  const runtime = new SmolRuntime(runtimeConfig, fetcher);
  const app = new Hono();
  const machines = "/api/v1/machines";

  app.onError((error, c) => {
    if (error instanceof HTTPException) return error.getResponse();
    if (error instanceof z.ZodError || error instanceof SyntaxError) {
      return c.json({ error: "Invalid request" }, 400);
    }
    // Do not return commands, environment values, or upstream error bodies.
    return c.json({ error: "Internal server error" }, 500);
  });
  // Authenticate before reading any body, so unauthenticated callers cannot
  // make the daemon buffer up to the body limit.
  // Service routes carry their own signed token instead of the secret key
  // (see `./internal/services.ts`); every other path requires the key.
  const checkSecretKey = requireSecretKey(secretKey);
  app.use("*", (c, next) =>
    c.req.path.startsWith(SERVICES_PREFIX) ? next() : checkSecretKey(c, next),
  );
  app.use(`${machines}/*`, bodyLimit({ maxSize: 64 * 1024 * 1024 }));
  app.get("/health", (c) => c.json({ status: "ok" }));
  app.get(machines, () => runtime.request(""));
  app.post(machines, async (c) => {
    const input = createMachineSchema.parse(await c.req.json());
    const image = resolveImage(input.image, images, configPath);
    const ports =
      input.ports &&
      (await Promise.all(
        input.ports.map(async ({ guest }) => ({
          host: await allocatePort(),
          guest,
        })),
      ));
    return runtime.request("", "POST", { ...input, image, ports });
  });
  app.get(`${machines}/:name`, (c) =>
    runtime.request(machinePath(c.req.param("name"))),
  );
  app.delete(`${machines}/:name`, (c) =>
    runtime.request(machinePath(c.req.param("name")), "DELETE"),
  );
  for (const action of ["start", "stop"] as const) {
    app.post(`${machines}/:name/${action}`, (c) =>
      runtime.request(`${machinePath(c.req.param("name"))}/${action}`, "POST"),
    );
  }
  app.post(`${machines}/:name/exec`, async (c) =>
    runtime.request(
      `${machinePath(c.req.param("name"))}/exec`,
      "POST",
      execSchema.parse(await c.req.json()),
    ),
  );
  app.get(`${machines}/:name/files/*`, (c) =>
    runtime.request(filePath(c.req.param("name"), c.req.path)),
  );
  app.put(`${machines}/:name/files/*`, async (c) => {
    const path = filePath(c.req.param("name"), c.req.path);
    return runtime.request(
      path,
      "PUT",
      new Uint8Array(await c.req.arrayBuffer()),
    );
  });
  app.all(`${SERVICES_PREFIX}*`, (c) =>
    proxyService(c.req.raw, secretKey, runtime, fetcher),
  );
  return app;
}

/**
 * Forward one HTTP request to a machine's published guest port. WebSocket
 * upgrades never reach Hono; `./internal/server.ts` pipes those.
 */
async function proxyService(
  request: Request,
  secretKey: string,
  runtime: SmolRuntime,
  fetcher: typeof fetch,
): Promise<Response> {
  const url = new URL(request.url);
  const route = parseServicePath(url.pathname);
  // One answer for a bad path, a bad token, and an unpublished port, so the
  // route never confirms which machines or ports exist.
  if (!route || !verifyServiceToken(secretKey, route)) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }
  const hostPort = await resolveHostPort(runtime, route.machine, route.port);
  if (hostPort === null) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }
  const headers = new Headers(request.headers);
  stripHopByHopHeaders(headers);
  headers.delete("host");
  let upstream: Response;
  try {
    upstream = await fetcher(
      `http://127.0.0.1:${hostPort}${route.path}${url.search}`,
      {
        method: request.method,
        headers,
        body: request.body,
        redirect: "manual",
        signal: request.signal,
        // Required by Node's fetch to stream a request body.
        duplex: "half",
      } as RequestInit,
    );
  } catch {
    return Response.json({ error: "Service unavailable" }, { status: 502 });
  }
  const responseHeaders = new Headers(upstream.headers);
  stripHopByHopHeaders(responseHeaders);
  // fetch has already decoded the body, so its encoding and length no
  // longer describe what is sent on.
  responseHeaders.delete("content-encoding");
  responseHeaders.delete("content-length");
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  });
}

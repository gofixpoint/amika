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
  RIGS_PREFIX,
  SERVICE_KEY_HEADER,
  authorizeServiceRequest,
  freeLoopbackPort,
  parseServicePath,
  resolveHostPort,
  stripHopByHopHeaders,
} from "./internal/services.js";
import {
  memoryServiceRegistry,
  type ServiceRegistry,
} from "./internal/service-registry.js";

export interface AppConfig extends SmolRuntimeConfig {
  /**
   * Every request must present this: as a bearer token, or in
   * `X-Amika-Hostd-Key` on `/rigs/.../services/...` routes, whose
   * `Authorization` belongs to the guest.
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
  /** Where each machine's service names map to guest ports. */
  registry?: ServiceRegistry;
}

/** Build routes without opening a socket; the runtime transport is injectable. */
export function createApp(
  { secretKey, images = {}, configPath, ...runtimeConfig }: AppConfig,
  fetcher = fetch,
  {
    allocatePort = freeLoopbackPort,
    registry = memoryServiceRegistry(),
  }: AppDeps = {},
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
  // Service routes take the key in their own header, checked by their
  // handler before it touches the body (see `./internal/services.ts`).
  const checkSecretKey = requireSecretKey(secretKey);
  app.use("*", (c, next) =>
    c.req.path.startsWith(RIGS_PREFIX) ? next() : checkSecretKey(c, next),
  );
  app.use(`${machines}/*`, bodyLimit({ maxSize: 64 * 1024 * 1024 }));
  app.get("/health", (c) => c.json({ status: "ok" }));
  app.get(machines, () => runtime.request(""));
  app.post(machines, async (c) => {
    const input = createMachineSchema.parse(await c.req.json());
    const { services, ...machine } = input;
    const image = resolveImage(machine.image, images, configPath);
    const guestPorts = [...new Set(services?.map((s) => s.port))];
    const ports =
      services &&
      (await Promise.all(
        guestPorts.map(async (guest) => ({
          host: await allocatePort(),
          guest,
        })),
      ));
    const response = await runtime.request("", "POST", {
      ...machine,
      image,
      ports,
    });
    // Record names only for a machine that now exists, replacing any a
    // deleted machine of the same name left behind.
    if (response.ok) {
      registry.set(
        machine.name,
        Object.fromEntries((services ?? []).map((s) => [s.name, s.port])),
      );
    }
    return response;
  });
  app.get(`${machines}/:name`, (c) =>
    runtime.request(machinePath(c.req.param("name"))),
  );
  app.delete(`${machines}/:name`, async (c) => {
    const name = c.req.param("name");
    const response = await runtime.request(machinePath(name), "DELETE");
    if (response.ok || response.status === 404) registry.remove(name);
    return response;
  });
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
  app.all(`${RIGS_PREFIX}*`, (c) =>
    proxyService(c.req.raw, secretKey, runtime, registry, fetcher),
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
  registry: ServiceRegistry,
  fetcher: typeof fetch,
): Promise<Response> {
  const refusal = authorizeServiceRequest(secretKey, {
    key: request.headers.get(SERVICE_KEY_HEADER),
    authorization: request.headers.get("authorization"),
  });
  if (refusal === 401) {
    // Close the connection so Node stops reading an unauthenticated body.
    return Response.json(
      { error: "Unauthorized" },
      { status: 401, headers: { Connection: "close" } },
    );
  }
  if (refusal === 400) {
    return Response.json(
      {
        error: `Send the host key in ${SERVICE_KEY_HEADER}, not Authorization, which is forwarded to the guest`,
      },
      { status: 400 },
    );
  }
  const url = new URL(request.url);
  const route = parseServicePath(url.pathname);
  const hostPort = route && (await resolveHostPort(runtime, registry, route));
  if (!route || hostPort === null) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }
  const headers = new Headers(request.headers);
  stripHopByHopHeaders(headers);
  headers.delete(SERVICE_KEY_HEADER);
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

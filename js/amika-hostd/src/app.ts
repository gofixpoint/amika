/** HTTP surface for the local VM host daemon. */
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { requireSecretKey } from "./internal/auth.js";
import {
  RuntimeError,
  type MachineRuntime,
} from "./internal/machine-runtime.js";
import {
  createMachineSchema,
  execSchema,
  filePath,
  machineName,
  replaceServicesSchema,
  resolveImage,
} from "./internal/requests.js";
import {
  SERVICE_KEY_HEADER,
  authorizeServiceRequest,
  parseServicePath,
  resolveHostPort,
  stripHopByHopHeaders,
} from "./internal/services.js";
import {
  memoryServiceRegistry,
  type ServiceRegistry,
} from "./internal/service-registry.js";

export interface AppConfig {
  /**
   * Every request must present this: as a bearer token, or in
   * `X-Amika-Hostd-Key` on `/v0beta1/rigs/.../services/...` routes, whose
   * `Authorization` belongs to the guest.
   */
  secretKey: string;
  /** Preset image names mapped to the OCI references machines boot. */
  images?: Record<string, string>;
  /** Named in errors for unconfigured images, so operators know what to edit. */
  configPath?: string;
  /**
   * How long a machine API request waits on the runtime before answering
   * 504. The runtime call itself carries on (an image pull, say).
   */
  requestTimeoutMs?: number;
}

export interface AppDeps {
  /** Where each machine's service names map to guest ports. */
  registry?: ServiceRegistry;
  /** Reaches a machine's published guest ports for service routes. */
  fetch?: typeof fetch;
  /**
   * hostd's own throwaway machines (`prepull.ts`), left out of the machine
   * list so Amika never sees them as rigs.
   */
  hiddenMachines?: () => ReadonlySet<string>;
}

/** Build routes without opening a socket; the runtime is injectable. */
export function createApp(
  {
    secretKey,
    images = {},
    configPath,
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  }: AppConfig,
  runtime: MachineRuntime,
  {
    registry = memoryServiceRegistry(),
    fetch: fetcher = fetch,
    hiddenMachines = () => new Set(),
  }: AppDeps = {},
) {
  const timeoutMs = z.number().int().positive().parse(requestTimeoutMs);
  /**
   * Answer with a runtime call's result, or with its failure's status and a
   * fixed message, followed by smolvm's reason when the runtime vouches it
   * safe to pass on (see `RuntimeError.reason`): engine errors can echo
   * commands and environment values.
   */
  const call = async (run: () => Promise<Response>): Promise<Response> => {
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), timeoutMs);
    });
    const result = run();
    // A call that fails after the deadline is answered already.
    result.catch(() => {});
    try {
      const response = await Promise.race([result, timedOut]);
      if (response === "timeout") {
        return Response.json(
          { error: "Smol runtime request timed out" },
          { status: 504 },
        );
      }
      return response;
    } catch (error) {
      if (error instanceof HTTPException) throw error;
      const reason = error instanceof RuntimeError ? error.reason : undefined;
      return Response.json(
        {
          error:
            reason === undefined
              ? "Smol runtime request failed"
              : `Smol runtime request failed: ${reason}`,
        },
        { status: error instanceof RuntimeError ? error.status : 500 },
      );
    } finally {
      clearTimeout(timer);
    }
  };
  const app = new Hono();

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
    parseServicePath(c.req.path) ? next() : checkSecretKey(c, next),
  );
  // `apis` names the versioned APIs this daemon serves, so a control plane
  // can tell what a host speaks before relying on it.
  app.get("/health", (c) => c.json({ status: "ok", apis: [API_VERSION] }));
  // Service routes are registered first, so `/<rig>/services/<name>/...`
  // never falls through to a machine route.
  app.all(`${RIGS_ROUTE}/:name/services/:service/*`, (c) =>
    proxyService(c.req.raw, secretKey, runtime, registry, fetcher),
  );
  app.all(`${RIGS_ROUTE}/:name/services/:service`, (c) =>
    proxyService(c.req.raw, secretKey, runtime, registry, fetcher),
  );
  // The machine API, at its versioned path and at the unversioned path
  // control planes on providers older than `v0beta1` still call.
  for (const machines of [RIGS_ROUTE, LEGACY_MACHINES_ROUTE]) {
    machineRoutes(machines);
  }
  return app;

  function machineRoutes(machines: string) {
    app.use(`${machines}/*`, bodyLimit({ maxSize: 64 * 1024 * 1024 }));
    // hostd's own pre-pull machines are no rigs of Amika's.
    app.get(machines, () =>
      call(async () => {
        const listed = await runtime.list();
        // Read after listing: a machine is recorded before it is created, so
        // any machine the list shows is already named here.
        const hidden = hiddenMachines();
        return Response.json({
          machines: listed.filter((machine) => !hidden.has(machine.name)),
        });
      }),
    );
    app.post(machines, async (c) => {
      const input = createMachineSchema.parse(await c.req.json());
      const { services, ...machine } = input;
      const image = resolveImage(machine.image, images, configPath);
      return call(async () => {
        const created = await runtime.create({ ...machine, image, services });
        // Record names only for a machine that now exists, replacing any a
        // deleted machine of the same name left behind.
        registry.set(
          machine.name,
          Object.fromEntries((services ?? []).map((s) => [s.name, s.port])),
        );
        return Response.json(created, { status: 201 });
      });
    });
    app.get(`${machines}/:name`, (c) => {
      const name = machineName(c.req.param("name"));
      return call(async () => Response.json(await runtime.get(name)));
    });
    app.delete(`${machines}/:name`, (c) => {
      const name = machineName(c.req.param("name"));
      return call(async () => {
        try {
          await runtime.remove(name);
        } catch (error) {
          if (error instanceof RuntimeError && error.status === 404) {
            registry.remove(name);
          }
          throw error;
        }
        registry.remove(name);
        return new Response(null, { status: 204 });
      });
    });
    // Services can be added, renamed and removed after create, but only on
    // ports published then: a machine cannot publish more later.
    app.put(`${machines}/:name/services`, async (c) => {
      const name = machineName(c.req.param("name"));
      const { services } = replaceServicesSchema.parse(await c.req.json());
      return call(async () => {
        try {
          await runtime.checkServices(name, services);
        } catch (error) {
          // The refusal names the unpublished ports and nothing secret.
          if (error instanceof RuntimeError && error.status === 409) {
            return Response.json({ error: error.message }, { status: 409 });
          }
          throw error;
        }
        registry.set(
          name,
          Object.fromEntries(services.map((s) => [s.name, s.port])),
        );
        return new Response(null, { status: 204 });
      });
    });
    for (const action of ["start", "stop"] as const) {
      app.post(`${machines}/:name/${action}`, (c) => {
        const name = machineName(c.req.param("name"));
        return call(async () => Response.json(await runtime[action](name)));
      });
    }
    app.post(`${machines}/:name/exec`, async (c) => {
      const name = machineName(c.req.param("name"));
      const request = execSchema.parse(await c.req.json());
      return call(async () => Response.json(await runtime.exec(name, request)));
    });
    app.get(`${machines}/:name/files/*`, (c) => {
      const name = machineName(c.req.param("name"));
      const path = filePath(name, c.req.path, machines);
      return call(async () => {
        // smolvm's bytes and type as it sent them: JSON for a directory.
        // Streamed through, never buffered.
        const file = await runtime.readFile(name, path);
        return new Response(file.body, {
          headers: { "Content-Type": file.contentType },
        });
      });
    });
    app.put(`${machines}/:name/files/*`, async (c) => {
      const name = machineName(c.req.param("name"));
      const path = filePath(name, c.req.path, machines);
      const data = new Uint8Array(await c.req.arrayBuffer());
      return call(async () => {
        await runtime.writeFile(name, path, data);
        return new Response(null, { status: 204 });
      });
    });
  }
}

/** Bounds a runtime call, including an image pull on first boot. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 300_000;

/** The versioned API this daemon serves. */
export const API_VERSION = "v0beta1";
const RIGS_ROUTE = `/${API_VERSION}/rigs`;
/** The Smol-compatible machine API, served until no control plane needs it. */
const LEGACY_MACHINES_ROUTE = "/api/v1/machines";

/**
 * Forward one HTTP request to a machine's published guest port. WebSocket
 * upgrades never reach Hono; `./internal/server.ts` pipes those.
 */
async function proxyService(
  request: Request,
  secretKey: string,
  runtime: MachineRuntime,
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

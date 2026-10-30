/** HTTP surface for the local VM host daemon. */
import { IncomingMessage } from "node:http";
import { Hono, type Context, type Next } from "hono";
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
  createSnapshotSchema,
  execSchema,
  filePath,
  machineName,
  replaceServicesSchema,
  resolveSource,
} from "./internal/requests.js";
import {
  fromRequest,
  hardenPreviewResponse,
  type Gateway,
} from "@amika/service-auth/gateway";
import {
  SnapshotConflictError,
  SnapshotNameError,
  validName as validSnapshotName,
  type SnapshotStore,
} from "./internal/snapshot-store.js";
import {
  BROWSER_LOGIN_FEATURE,
  CALLBACK_PATH,
  LOGIN_PATH,
} from "@amika/service-auth/credentials";
import {
  hostdGateway,
  isForwardingHeader,
  publicForwarding,
  resolveHostPort,
  stripHopByHopHeaders,
} from "./internal/services.js";
import {
  memoryServiceRegistry,
  type ServiceRegistry,
} from "./internal/service-registry.js";
import { namedRoute, type NamedRoute } from "./internal/tunnel-rig-route.js";

export interface AppConfig {
  /**
   * Every request must present this: as a bearer token, or in
   * `X-Amika-Hostd-Key` on `/v0beta1/rigs/.../services/...` routes, whose
   * `Authorization` belongs to the guest. A service token or a browser
   * session signed with a key derived from it may stand in on service and
   * preview routes.
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
  /**
   * Amika's URL, where a browser opening a preview is sent to log in
   * (`@amika/service-auth/gateway`). Without it hostd serves no previews.
   */
  amikaUrl?: string;
  /**
   * A bare-metal host, whose one rig is this machine: create takes no image
   * (nothing is resolved), and the files routes are not served, so nothing
   * reaches the machine's files. Snapshots are never offered either. What
   * exec may run is the runtime's to refuse (`bare-metal-runtime.ts`).
   */
  bareMetal?: boolean;
}

/**
 * Taking and keeping snapshots, which only a daemon running its own smolvm
 * can do (it packs through that binary). Absent, the snapshot routes are not
 * served and `/health` does not claim the feature, so a control plane can
 * tell a host that cannot snapshot from one that can.
 */
export interface SnapshotSupport {
  store: SnapshotStore;
  /**
   * Reserve `name` and start packing `rig` in the background. Resolves once
   * the name is held, which is all the route waits for.
   */
  capture(rig: string, name: string): Promise<void>;
}

export interface AppDeps {
  /** Where each machine's service names map to guest ports. */
  registry?: ServiceRegistry;
  /** This host's snapshots; without it, rigs cannot be snapshotted. */
  snapshots?: SnapshotSupport;
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
    amikaUrl,
    bareMetal = false,
  }: AppConfig,
  runtime: MachineRuntime,
  {
    registry = memoryServiceRegistry(),
    snapshots: offered,
    fetch: fetcher = fetch,
    hiddenMachines = () => new Set(),
  }: AppDeps = {},
) {
  // A bare-metal host has no disk image to capture, whatever it was given.
  const snapshots = bareMetal ? undefined : offered;
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
  /** The store as `resolveSource` reads it; empty when snapshots are off. */
  const snapshotSource = {
    get: (name: string) => snapshots?.store.get(name),
    artifact: (name: string) => snapshots?.store.artifact(name),
  };
  const app = new Hono();

  app.onError((error, c) => {
    if (error instanceof HTTPException) return error.getResponse();
    if (error instanceof z.ZodError || error instanceof SyntaxError) {
      return c.json({ error: "Invalid request" }, 400);
    }
    // Snapshot refusals carry no command, environment value, or file
    // contents, only the name the caller already sent.
    if (error instanceof SnapshotNameError) {
      return c.json({ error: error.message }, 400);
    }
    if (error instanceof SnapshotConflictError) {
      return c.json({ error: error.message }, 409);
    }
    // A runtime failure from outside `call` (a capture resolves its rig
    // before the route can wrap it), shaped as `call` shapes one: the
    // runtime's own status, and smolvm's reason only when it vouched it
    // safe. Without this a capture of a rig that is not there would look
    // like a broken host rather than a `404`.
    if (error instanceof RuntimeError) {
      return Response.json(
        {
          error:
            error.reason === undefined
              ? "Smol runtime request failed"
              : `Smol runtime request failed: ${error.reason}`,
        },
        { status: error.status },
      );
    }
    // Do not return commands, environment values, or upstream error bodies.
    return c.json({ error: "Internal server error" }, 500);
  });
  // Authenticate before reading any body, so unauthenticated callers cannot
  // make the daemon buffer up to the body limit.
  // Service routes, preview routes and a guest path the preview cookie
  // claims are the gateway's: it checks each before the body is touched
  // (`@amika/service-auth/gateway`). Everything else needs the secret key.
  const gateway = hostdGateway(secretKey, amikaUrl);
  const checkSecretKey = requireSecretKey(secretKey);
  // A request the tunnel named by its hostname is that service's, whatever
  // its path: `/v0beta1/rigs` on `web--rig.r.org.o.<zone>` is the rig's own
  // page, never this daemon's machine list. So it goes to the service
  // before any route here can match it, but for the login endpoints, which
  // are how a browser logs in to that origin.
  app.use("*", (c, next) => {
    const named = namedRoute(incomingOf(c.env));
    if (!named) return next();
    // Exactly the two login routes, method and all. Anything else on those
    // paths would fall past them to the catch-all, which routes by the
    // preview cookie, and a page can set that cookie on its own origin to
    // reach another rig. Here it goes to the service, and is refused as
    // not the service's (`authorizeNamed` leaves the login paths alone).
    if (gateway.servesPreviews && isLoginRoute(c.req.method, c.req.url)) {
      return next();
    }
    return proxyService(c.req.raw, gateway, runtime, registry, fetcher, named);
  });
  app.use("*", (c, next) =>
    gateway.claims(fromRequest(c.req.raw)) ? next() : checkSecretKey(c, next),
  );
  // `apis` names the versioned APIs this daemon serves, so a control plane
  // can tell what a host speaks before relying on it.
  // `features` names what a control plane may rely on beyond the API itself:
  // `service-tokens`, service routes accepting `X-Amika-Authorization`, and
  // `browser-login`, previews behind a login through Amika.
  app.get("/health", (c) =>
    c.json({
      status: "ok",
      apis: [API_VERSION],
      // Each feature is served independently of the others, so each adds
      // itself.
      features: [
        ...FEATURES,
        ...(gateway.servesPreviews ? [BROWSER_LOGIN_FEATURE] : []),
        ...(snapshots ? [SNAPSHOTS_FEATURE] : []),
        ...(bareMetal ? [BARE_METAL_FEATURE] : []),
      ],
    }),
  );
  // Service routes are registered first, so `/<rig>/services/<name>/...`
  // never falls through to a machine route.
  app.all(`${RIGS_ROUTE}/:name/services/:service/*`, (c) =>
    proxyService(c.req.raw, gateway, runtime, registry, fetcher),
  );
  app.all(`${RIGS_ROUTE}/:name/services/:service`, (c) =>
    proxyService(c.req.raw, gateway, runtime, registry, fetcher),
  );
  // Snapshots, only at the versioned path: a control plane old enough to
  // call the legacy machine API knows nothing about them.
  if (snapshots) snapshotRoutes(snapshots);
  if (gateway.servesPreviews) {
    app.get(LOGIN_PATH, (c) => gateway.startLogin(c.req.raw));
    app.post(CALLBACK_PATH, bodyLimit({ maxSize: 16 * 1024 }), (c) =>
      gateway.finishLogin(c.req.raw),
    );
    // A preview missing its trailing slash would resolve the service's
    // relative URLs one segment up, so it is sent to the full preview. The
    // redirect grants nothing. It is registered first because Hono's `/*`
    // also matches the bare path.
    app.all(`${RIGS_ROUTE}/:name/previews/:service`, (c) => {
      const url = new URL(c.req.url);
      return hardenPreviewResponse(
        new Response(null, {
          status: 308,
          headers: { Location: `${url.pathname}/${url.search}` },
        }),
      );
    });
    app.all(`${RIGS_ROUTE}/:name/previews/:service/*`, (c) =>
      proxyService(c.req.raw, gateway, runtime, registry, fetcher),
    );
  }
  // The machine API, at its versioned path and at the unversioned path
  // control planes on providers older than `v0beta1` still call.
  for (const machines of [RIGS_ROUTE, LEGACY_MACHINES_ROUTE]) {
    machineRoutes(machines);
  }
  // Last, so it only sees what no route above claims: a root-relative URL a
  // page opened through a preview asks for, sent to the service the preview
  // cookie names, which the gateway decides.
  app.all("*", async (c) =>
    gateway.claims(fromRequest(c.req.raw))
      ? proxyService(c.req.raw, gateway, runtime, registry, fetcher)
      : c.notFound(),
  );
  return app;

  function snapshotRoutes({ store, capture }: SnapshotSupport) {
    // Taking one: the rig is stopped and packed in the background, so this
    // answers as soon as the name is held. The control plane polls the
    // snapshot until it leaves `capturing`.
    // Its own limit: the machine routes' `bodyLimit` is registered with them,
    // below this, so it never runs for a route declared here. The body is one
    // name, so this only has to be small enough that an authenticated caller
    // cannot make the daemon buffer megabytes before the name is parsed.
    app.post(
      `${RIGS_ROUTE}/:name/snapshots`,
      bodyLimit({ maxSize: 64 * 1024 }),
      async (c) => {
        const rig = machineName(c.req.param("name"));
        const { name } = createSnapshotSchema.parse(await c.req.json());
        // Outside `call`: a refusal here is the request's (a name already
        // taken), not the runtime's, and `app.onError` shapes it.
        await capture(rig, name);
        return c.json(store.get(name), 202);
      },
    );
    app.get(SNAPSHOTS_ROUTE, (c) => c.json({ snapshots: store.list() }));
    // A wildcard, not a parameter: Amika's snapshot names carry slashes.
    app.get(`${SNAPSHOTS_ROUTE}/*`, (c) => {
      const name = snapshotName(c.req.path);
      const snapshot = store.get(name);
      return snapshot
        ? c.json(snapshot)
        : c.json({ error: "Snapshot not found" }, 404);
    });
    app.delete(`${SNAPSHOTS_ROUTE}/*`, (c) => {
      const name = snapshotName(c.req.path);
      return call(async () => {
        // Deleting a snapshot that is not there is a success, as deleting
        // any absent resource is; one still being taken is not, since the
        // capture would write its artifact back after the delete.
        if (store.get(name)?.state === "capturing") {
          return Response.json(
            { error: "Snapshot is still being taken; wait for it to finish" },
            { status: 409 },
          );
        }
        // Rigs created from it do not need it: smolvm copies an artifact's
        // layers into its own storage when it creates a machine from one.
        store.remove(name);
        return new Response(null, { status: 204 });
      });
    });
  }

  /**
   * Refuse to touch a rig while it is being packed. The pack reads the rig's
   * disks from its own process, outside smolvm's lifecycle lock, so smolvm
   * would start, exec in or delete the rig mid-pack, and the snapshot would
   * be read from disks being written. The control plane holds such a rig
   * too, but only for as long as it waits on the capture, which a large
   * pack can outlast. Reading the rig is still served.
   */
  async function leaveCapturedRigAlone(c: Context, next: Next) {
    const rig = c.req.param("name");
    if (rig !== undefined && snapshots?.store.isCapturing(rig)) {
      return c.json(
        { error: "Rig is being snapshotted; try again once that finishes" },
        409,
      );
    }
    await next();
  }

  function machineRoutes(machines: string) {
    app.use(`${machines}/*`, bodyLimit({ maxSize: 64 * 1024 * 1024 }));
    // Everything but reading the rig: a file read may boot a stopped one.
    app.on(
      ["POST", "PUT", "DELETE"],
      [`${machines}/:name`, `${machines}/:name/*`],
      leaveCapturedRigAlone,
    );
    app.get(`${machines}/:name/files/*`, leaveCapturedRigAlone);
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
      const { services, image: named, ...machine } = input;
      // The rig is this machine as it is, so a bare-metal host boots no
      // image: the name is passed along unresolved, and ignored.
      const source = bareMetal
        ? { image: named }
        : resolveSource(named, images, snapshotSource, configPath);
      return call(async () => {
        const created = await runtime.create({
          ...machine,
          ...source,
          services,
        });
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
    // Not served on bare metal: the control plane must not read or write
    // the machine's files. Unregistered, a files path is a 404 like any
    // other path hostd does not serve.
    if (bareMetal) return;
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
export const FEATURES = ["service-tokens"];
const RIGS_ROUTE = `/${API_VERSION}/rigs`;
/** This host's snapshots, which belong to the host rather than to one rig. */
const SNAPSHOTS_ROUTE = `/${API_VERSION}/snapshots`;
/** Named in `/health` by a daemon that can take snapshots. */
export const SNAPSHOTS_FEATURE = "snapshots";
/**
 * Named in `/health` by a bare-metal host: one rig, exec limited to the
 * amikad commands that set up SSH, and no files or snapshots.
 */
export const BARE_METAL_FEATURE = "bare-metal";

/** The Smol-compatible machine API, served until no control plane needs it. */
const LEGACY_MACHINES_ROUTE = "/api/v1/machines";

/**
 * The snapshot a `/v0beta1/snapshots/...` path names: everything after the
 * collection, decoded once. A wildcard rather than a route parameter because
 * Amika's snapshot names are namespaced and so contain slashes, which a
 * parameter would not match, and which a caller may also send
 * percent-encoded.
 */
function snapshotName(requestPath: string): string {
  const rest = requestPath.slice(`${SNAPSHOTS_ROUTE}/`.length);
  let decoded: string;
  try {
    decoded = decodeURIComponent(rest);
  } catch {
    throw new HTTPException(400, { message: "Invalid snapshot name" });
  }
  return validSnapshotName(decoded);
}

/** Whether this is one of the two routes a browser logs in through. */
function isLoginRoute(method: string, url: string): boolean {
  const { pathname } = new URL(url);
  if (pathname === LOGIN_PATH) return method === "GET" || method === "HEAD";
  return pathname === CALLBACK_PATH && method === "POST";
}

/**
 * The Node request under a Hono context's `env`, as `@hono/node-server`
 * passes it, or undefined for a request that came another way (a test's
 * `app.request`, say).
 */
function incomingOf(env: unknown): IncomingMessage | undefined {
  if (typeof env !== "object" || env === null || !("incoming" in env)) {
    return undefined;
  }
  const { incoming } = env as { incoming: unknown };
  return incoming instanceof IncomingMessage ? incoming : undefined;
}

/**
 * Forward a request the gateway claims to the service it names, as the
 * gateway decides: refused, or forwarded without the gateway's credentials,
 * with its answer finished by the gateway (a preview's cookie and hardening).
 */
async function proxyService(
  request: Request,
  gateway: Gateway,
  runtime: MachineRuntime,
  registry: ServiceRegistry,
  fetcher: typeof fetch,
  /** The service the tunnel named the request for, if it did. */
  named?: NamedRoute,
): Promise<Response> {
  const decision = await gateway.authorize({ ...fromRequest(request), named });
  if (decision.kind === "not-mine") {
    return Response.json({ error: "Not found" }, { status: 404 });
  }
  if (decision.kind === "refuse") return gateway.refusal(decision);
  if (decision.kind === "login") return gateway.login(decision);
  const { route } = decision;
  const hostPort = await resolveHostPort(runtime, registry, route);
  if (hostPort === null) {
    return gateway.harden(
      decision,
      Response.json({ error: "Not found" }, { status: 404 }),
    );
  }
  const url = new URL(request.url);
  const forwarded = new Headers(request.headers);
  stripHopByHopHeaders(forwarded);
  for (const name of [...forwarded.keys()]) {
    if (gateway.isCredentialHeader(name)) forwarded.delete(name);
  }
  forwarded.delete("host");
  // At its own address, the service is told that address
  // (`publicForwarding`), and nothing the caller claimed about it.
  if (named) {
    for (const name of [...forwarded.keys()]) {
      if (isForwardingHeader(name)) forwarded.delete(name);
    }
    for (const [name, value] of publicForwarding(url.host)) {
      forwarded.set(name, value);
    }
  }
  const guestCookies = gateway.guestCookies(forwarded.get("cookie"));
  if (guestCookies) forwarded.set("cookie", guestCookies);
  else forwarded.delete("cookie");
  let upstream: Response;
  try {
    upstream = await fetcher(
      `http://127.0.0.1:${hostPort}${route.path}${url.search}`,
      {
        method: request.method,
        headers: forwarded,
        body: request.body,
        redirect: "manual",
        signal: request.signal,
        // Required by Node's fetch to stream a request body.
        duplex: "half",
      } as RequestInit,
    );
  } catch {
    return gateway.harden(
      decision,
      Response.json({ error: "Service unavailable" }, { status: 502 }),
    );
  }
  const responseHeaders = new Headers(upstream.headers);
  stripHopByHopHeaders(responseHeaders);
  // fetch has already decoded the body, so its encoding and length no
  // longer describe what is sent on.
  responseHeaders.delete("content-encoding");
  responseHeaders.delete("content-length");
  return gateway.finish(
    decision,
    new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: responseHeaders,
    }),
  );
}

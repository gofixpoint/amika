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
  isHostdPath,
  linkCookie,
  linkFromCookie,
  withoutHostdCookies,
  type LinkCookieClaim,
} from "./internal/link-cookie.js";
import {
  CALLBACK_PATH,
  LOGIN_PATH,
  finishLogin,
  hardenPreviewResponse,
  hasSession,
  loginRedirect,
  parsePreviewPath,
  previewCookie,
  previewFromCookie,
  startLogin,
  usedLoginStates,
} from "./internal/browser-login.js";
import { SERVICE_TOKEN_HEADER } from "@amika/sandbox/hostd-service-links";
import { BROWSER_LOGIN_FEATURE } from "@amika/sandbox/hostd-browser-login";
import {
  AMIKAD_SERVICE,
  SERVICE_KEY_HEADER,
  SERVICE_TOKEN_HEADER_NAME,
  authorizeServiceLinkRequest,
  authorizeServiceRouteRequest,
  parseServiceLinkPath,
  parseServicePath,
  resolveHostPort,
  stripHopByHopHeaders,
  type ServiceRoute,
} from "./internal/services.js";
import {
  memoryServiceRegistry,
  type ServiceRegistry,
} from "./internal/service-registry.js";

export interface AppConfig {
  /**
   * Every request must present this: as a bearer token, or in
   * `X-Amika-Hostd-Key` on `/v0beta1/rigs/.../services/...` routes, whose
   * `Authorization` belongs to the guest. `/v0beta1/rigs/.../service-links/...`
   * routes present a link signed with a key derived from it instead.
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
   * (`./internal/browser-login.ts`). Without it hostd serves no previews.
   */
  amikaUrl?: string;
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
    amikaUrl,
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
  // Service routes take the key in their own header, service-link routes a
  // signed link, and a guest path the link cookie, each checked by its
  // handler before it touches the body (see `./internal/services.ts` and
  // `./internal/link-cookie.ts`).
  const checkSecretKey = requireSecretKey(secretKey);
  // Previews and the login pages are checked the same way, against the
  // browser's session or login state (`./internal/browser-login.ts`).
  const previews = amikaUrl !== undefined;
  const loginStates = usedLoginStates();
  app.use("*", (c, next) =>
    parseServicePath(c.req.path) ||
    parseServiceLinkPath(c.req.path) ||
    (previews &&
      (c.req.path === LOGIN_PATH ||
        c.req.path === CALLBACK_PATH ||
        parsePreviewPath(c.req.path))) ||
    (!isHostdPath(c.req.path) &&
      (linkFromCookie(c.req.header("cookie"), c.req.header("sec-fetch-site")) ||
        (previews &&
          previewFromCookie(
            c.req.header("cookie"),
            c.req.header("sec-fetch-site"),
          ))))
      ? next()
      : checkSecretKey(c, next),
  );
  // `apis` names the versioned APIs this daemon serves, so a control plane
  // can tell what a host speaks before relying on it.
  // `features` names what a control plane may rely on beyond the API itself:
  // `service-tokens`, service routes accepting `X-Amika-Authorization`.
  // `browser-login`, previews behind a login through Amika.
  const features = previews ? [...FEATURES, BROWSER_LOGIN_FEATURE] : FEATURES;
  app.get("/health", (c) =>
    c.json({ status: "ok", apis: [API_VERSION], features }),
  );
  // Service routes are registered first, so `/<rig>/services/<name>/...`
  // never falls through to a machine route.
  app.all(`${RIGS_ROUTE}/:name/services/:service/*`, (c) =>
    proxyService(c.req.raw, secretKey, runtime, registry, fetcher),
  );
  app.all(`${RIGS_ROUTE}/:name/services/:service`, (c) =>
    proxyService(c.req.raw, secretKey, runtime, registry, fetcher),
  );
  // A link missing its trailing slash would resolve the service's relative
  // URLs one segment up, dropping the token, so it is sent to the full link.
  // The redirect grants nothing: the full link is verified as usual. It is
  // registered first because Hono's `/*` also matches the bare path.
  app.all(`${RIGS_ROUTE}/:name/service-links/:service/:token`, (c) => {
    const url = new URL(c.req.url);
    return hardenServiceLinkResponse(
      new Response(null, {
        status: 308,
        headers: { Location: `${url.pathname}/${url.search}` },
      }),
    );
  });
  app.all(`${RIGS_ROUTE}/:name/service-links/:service/:token/*`, async (c) =>
    hardenServiceLinkResponse(
      await proxyService(c.req.raw, secretKey, runtime, registry, fetcher),
    ),
  );
  if (amikaUrl !== undefined) {
    app.get(LOGIN_PATH, (c) => startLogin(c.req.raw, amikaUrl));
    app.post(CALLBACK_PATH, bodyLimit({ maxSize: 16 * 1024 }), (c) =>
      finishLogin(c.req.raw, secretKey, loginStates),
    );
    // As for a link: a preview missing its trailing slash would resolve the
    // service's relative URLs one segment up.
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
      proxyPreview(c.req.raw),
    );
  }
  // The machine API, at its versioned path and at the unversioned path
  // control planes on providers older than `v0beta1` still call.
  for (const machines of [RIGS_ROUTE, LEGACY_MACHINES_ROUTE]) {
    machineRoutes(machines);
  }
  // Last, so it only sees what no route above claims: a root-relative URL a
  // page opened through a link asks for, sent to the service the link
  // cookie names (`./internal/link-cookie.ts`).
  app.all("*", async (c) => {
    const claim = isHostdPath(c.req.path)
      ? null
      : linkFromCookie(c.req.header("cookie"), c.req.header("sec-fetch-site"));
    const preview =
      claim || !previews || isHostdPath(c.req.path)
        ? null
        : previewFromCookie(
            c.req.header("cookie"),
            c.req.header("sec-fetch-site"),
          );
    if (preview) {
      if (c.req.header("service-worker") === "script") {
        return hardenPreviewResponse(
          Response.json({ error: "Not found" }, { status: 404 }),
        );
      }
      return proxyPreview(c.req.raw, preview);
    }
    if (!claim) return c.notFound();
    // A worker script served from the root would claim every link on the
    // host, not just this one's (`hardenServiceLinkResponse`).
    if (c.req.header("service-worker") === "script") {
      return hardenServiceLinkResponse(
        Response.json({ error: "Not found" }, { status: 404 }),
      );
    }
    return hardenServiceLinkResponse(
      await proxyService(
        c.req.raw,
        secretKey,
        runtime,
        registry,
        fetcher,
        claim,
      ),
    );
  });
  return app;

  /**
   * Serve a preview to a browser with a session: the preview route itself,
   * or (`cookie`) a root-relative URL its page asked for. Without a session
   * a page load goes to log in, and anything else is refused.
   */
  async function proxyPreview(
    request: Request,
    cookie?: { machine: string; service: string },
  ): Promise<Response> {
    const url = new URL(request.url);
    const route = cookie
      ? { ...cookie, path: url.pathname }
      : parsePreviewPath(url.pathname);
    if (!route) {
      return hardenPreviewResponse(
        Response.json({ error: "Not found" }, { status: 404 }),
      );
    }
    if (!(await hasSession(request.headers.get("cookie"), url, secretKey))) {
      if (
        !cookie &&
        request.method === "GET" &&
        request.headers.get("sec-fetch-mode") === "navigate"
      ) {
        return loginRedirect(url);
      }
      return hardenPreviewResponse(
        Response.json(
          {
            error: "Unauthorized",
            hint: "Open the preview in a browser to log in through Amika, or send a service token to the rig's service route.",
          },
          { status: 401, headers: { Connection: "close" } },
        ),
      );
    }
    const response = await forwardService(
      request,
      route,
      runtime,
      registry,
      fetcher,
    );
    // Opening a preview hands its root-relative URLs to this service.
    const setCookie = !cookie && previewCookie(request, route);
    if (setCookie) response.headers.append("set-cookie", setCookie);
    return hardenPreviewResponse(response);
  }

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
export const FEATURES = ["service-tokens"];
const RIGS_ROUTE = `/${API_VERSION}/rigs`;
/** The Smol-compatible machine API, served until no control plane needs it. */
const LEGACY_MACHINES_ROUTE = "/api/v1/machines";

/**
 * Forward one HTTP request to a machine's published guest port. WebSocket
 * upgrades never reach Hono; `./internal/server.ts` pipes those.
 *
 * A request on a link route is authorized by its link; one carrying only the
 * link cookie, by the link `cookie` names, with its whole path as the guest
 * path.
 */
async function proxyService(
  request: Request,
  secretKey: string,
  runtime: MachineRuntime,
  registry: ServiceRegistry,
  fetcher: typeof fetch,
  cookie?: LinkCookieClaim,
): Promise<Response> {
  const url = new URL(request.url);
  const link = cookie
    ? { ...cookie, path: url.pathname }
    : parseServiceLinkPath(url.pathname);
  const headers = {
    key: request.headers.get(SERVICE_KEY_HEADER),
    token: request.headers.get(SERVICE_TOKEN_HEADER_NAME),
    authorization: request.headers.get("authorization"),
  };
  const serviceRoute = link ? null : parseServicePath(url.pathname);
  const refusal = link
    ? await authorizeServiceLinkRequest(secretKey, link, headers)
    : await authorizeServiceRouteRequest(secretKey, serviceRoute, headers);
  if (refusal === 401) {
    // Close the connection so Node stops reading an unauthenticated body.
    return Response.json(
      { error: "Unauthorized", ...tokenHint(serviceRoute, headers.token) },
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
  const route = link ?? serviceRoute;
  if (!route) return Response.json({ error: "Not found" }, { status: 404 });
  const response = await forwardService(
    request,
    route,
    runtime,
    registry,
    fetcher,
  );
  // Opening a link hands its root-relative URLs to this service.
  const setCookie = link && !cookie && linkCookie(request, link);
  if (setCookie) response.headers.append("set-cookie", setCookie);
  return response;
}

/**
 * Forward an authorized request to `route`'s guest port, without hostd's
 * own headers and cookies, and the guest's answer back. 404 when the rig
 * has no such service or is not running, 502 when the guest is down.
 */
async function forwardService(
  request: Request,
  route: ServiceRoute,
  runtime: MachineRuntime,
  registry: ServiceRegistry,
  fetcher: typeof fetch,
): Promise<Response> {
  const url = new URL(request.url);
  const hostPort = await resolveHostPort(runtime, registry, route);
  if (hostPort === null) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }
  const forwarded = new Headers(request.headers);
  stripHopByHopHeaders(forwarded);
  forwarded.delete(SERVICE_KEY_HEADER);
  forwarded.delete(SERVICE_TOKEN_HEADER_NAME);
  forwarded.delete("host");
  const guestCookies = withoutHostdCookies(forwarded.get("cookie"));
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

/**
 * What a refused caller on a service route should do next, for the `hint` of
 * its 401: someone running `curl` against a route with no credential is told
 * where a token goes, and one whose token was refused that it needs a new
 * one. Nothing for amikad, which takes only the host key.
 */
function tokenHint(
  route: ServiceRoute | null,
  token: string | null,
): { hint?: string } {
  if (!route || route.service === AMIKAD_SERVICE) return {};
  return {
    hint: token
      ? `The service token is invalid or expired; get a new one from Amika.`
      : `Send a service token from Amika in ${SERVICE_TOKEN_HEADER}: Bearer <token>.`,
  };
}

/**
 * Narrow where a service link's path can end up. The path carries the
 * signature that authorizes it, so every copy of the URL is a working
 * credential until it expires, and none can be revoked individually.
 *
 * Applied to every response on a link route, not only a proxied one.
 * hostd's own answers carry the same credential-bearing URL, and two are
 * cacheable without asking: a `404` for a service that is gone, and the
 * `308` that adds a missing trailing slash -- the most-travelled response
 * of all, since it catches every pasted link, and one whose `Location`
 * repeats the signature.
 *
 * Each header is `set`, not defaulted, and applied after a guest's own are
 * copied: the credential belongs to hostd, not to the service, so a service
 * must not be able to opt into spreading it. Stopgaps while the link is the
 * credential.
 */
function hardenServiceLinkResponse(response: Response): Response {
  const headers = response.headers;
  // Every link on the host shares one origin; without this a service worker
  // one link registers would claim the others' paths too.
  headers.delete("service-worker-allowed");
  // Keep the path out of `Referer`. Browsers already withhold it
  // cross-origin by default, but same-origin requests still carry the whole
  // URL and `Referer` is forwarded to the guest, so a co-hosted service
  // would otherwise be handed a working link. Note this is only the fallback
  // in the precedence chain -- `<meta name="referrer">` and a
  // `referrerpolicy` attribute beat it -- so it covers a service that sets no
  // policy, not one that sets out to leak.
  headers.set("referrer-policy", "no-referrer");
  // A cache entry is keyed by its URL, so storing one writes the signature to
  // disk, where it outlives the tab that fetched it. The cost is that a
  // preview re-fetches its assets, which is the right trade for a credential.
  headers.set("cache-control", "private, no-store");
  // And a link that reaches a crawler should not become a search result.
  headers.set("x-robots-tag", "noindex");
  return response;
}

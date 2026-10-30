/**
 * The gateway: who may reach which rig's service, decided per request, apart
 * from how the request then gets there. A server (amika-hostd) asks
 * `authorize` and acts on the decision: it forwards to the route it names,
 * answers the refusal, or handles the request itself (`not-mine`).
 *
 * Three ways in, each checked here:
 *
 * - `/v0beta1/rigs/<rig>/services/<name>/...` with the host's secret key in
 *   `X-Amika-Hostd-Key`, or a service token in `X-Amika-Authorization`
 *   (`./keys.ts`). On an upgrade only, amikad's SSH WebSocket may come with
 *   neither: `keyless`, which the server must still pin to amikad's port.
 * - With `amikaUrl`, `/v0beta1/rigs/<rig>/previews/<name>/...`, and any
 *   path outside the server's own (`isOwnPath`) with the preview cookie a
 *   preview set (a page's root-relative URLs), for a browser holding a
 *   session it logged in for through Amika (`./browser-login.ts`). The
 *   login itself runs on two endpoints the server mounts: `startLogin` and
 *   `finishLogin`.
 * - A request the server names (`GatewayRequest.named`): one that reached
 *   a service at its own hostname, `<service>--<rig>.r.<org>.o.<zone>`.
 *   Every path on that origin is the service's, but for the two login
 *   endpoints. It takes a browser session for that origin, as a preview
 *   does, and nothing else: no hop in front of it passes a caller's
 *   `x-amika-` credential headers. No cookie routes it, and none is set:
 *   the origin is the route. amikad takes no session; at its name it
 *   answers only its keyless SSH upgrade.
 *
 * Every credential is the gateway's: the server forwards none of them
 * (`isCredentialHeader`, `guestCookies`), it drops a guest's `Set-Cookie`
 * for any of the gateway's cookies (`finish`, `finishUpgrade`), and
 * responses on a preview are hardened (`harden`).
 */
import {
  SERVICE_KEY_HEADER,
  SERVICE_TOKEN_HEADER_NAME,
  authorizeServiceRequest,
  authorizeServiceRouteRequest,
} from "./keys";
import {
  carriesGatewayCookie,
  setsGatewayCookie,
  withoutGatewayCookies,
} from "./cookies";
import { tokenHint } from "./responses";
import {
  CALLBACK_PATH,
  LOGIN_PATH,
  finishLogin,
  hardenPreviewResponse,
  hasSession,
  isOwnOrPageLoad,
  loginLocation,
  loginRedirect,
  parsePreviewPath,
  previewCookies,
  previewFromCookie,
  sessionUser,
  startLogin,
  usedLoginStates,
} from "./browser-login";
import {
  AMIKAD_SERVICE,
  isAmikadSshUpgrade,
  isNamedAmikadSshUpgrade,
  parseServicePath,
  type GatewayRequest,
  type NamedService,
  type ServiceRoute,
} from "./routes";

export interface GatewayOptions {
  /** The host's secret key, from which every credential is derived. */
  secretKey: string;
  /**
   * The server's own paths, which the preview cookie never claims: its API,
   * every service and preview route, its health check.
   */
  isOwnPath: (pathname: string) => boolean;
  /**
   * Amika's URL, where a browser opening a preview is sent to log in.
   * Without it the gateway serves no previews.
   */
  amikaUrl?: string;
}

/**
 * Where a request came in: a keyed or token service route, or a preview (its
 * path, or its cookie). A preview's responses are hardened.
 */
export type GatewaySurface = "service" | "preview";

/** Forward the request to `route`'s service. */
export interface ForwardDecision {
  kind: "forward";
  surface: GatewaySurface;
  route: ServiceRoute;
  /**
   * amikad's SSH upgrade, let through without the key: the server must
   * forward it only to amikad on the port Amika registers it at.
   */
  keyless: boolean;
  /** To add to the response: a preview opened in a browser sets its cookie. */
  setCookies: string[];
}

/** Refuse the request with `status`. */
export interface RefuseDecision {
  kind: "refuse";
  surface: GatewaySurface;
  status: 400 | 401 | 403 | 404;
  /** What a refused `curl` should do next, for a 401's body. */
  hint?: string;
  /** Why a 403, for its body, when the default reason would mislead. */
  reason?: string;
}

/** Send the browser to log in, at `location`, before it may have this. */
export interface LoginDecision {
  kind: "login";
  location: string;
}

export type GatewayDecision =
  | ForwardDecision
  | RefuseDecision
  | LoginDecision
  /** Not a service request: the server handles it under its own rules. */
  | { kind: "not-mine" };

export type Gateway = ReturnType<typeof createGateway>;

export function createGateway({
  secretKey,
  isOwnPath,
  amikaUrl,
}: GatewayOptions) {
  const previews = amikaUrl !== undefined;
  const loginStates = usedLoginStates();
  /** A preview's path, or a root-relative URL its cookie routes. */
  const previewClaim = (request: GatewayRequest) => {
    if (!previews) return null;
    const { url, headers } = request;
    const route = parsePreviewPath(url.pathname);
    if (route) return { route, cookie: false };
    if (isOwnPath(url.pathname)) return null;
    const preview = previewFromCookie(
      headers.get("cookie"),
      headers.get("sec-fetch-site"),
    );
    return (
      preview && { route: { ...preview, path: url.pathname }, cookie: true }
    );
  };

  return {
    /**
     * Whether `authorize` decides this request, cheaply and without its
     * body, so the server can skip its own key check for it.
     */
    claims(request: GatewayRequest): boolean {
      const { pathname } = request.url;
      return Boolean(
        request.named ||
        parseServicePath(pathname) ||
        (previews && isLoginEndpoint(pathname)) ||
        previewClaim(request),
      );
    },

    /**
     * Who may have this request, and where it goes. `upgrade` for a
     * protocol upgrade (a WebSocket), which alone may be amikad's keyless
     * SSH upgrade and never sets a cookie.
     */
    async authorize(
      request: GatewayRequest,
      { upgrade = false }: { upgrade?: boolean } = {},
    ): Promise<GatewayDecision> {
      const { url, headers } = request;
      const credentials = {
        key: headers.get(SERVICE_KEY_HEADER),
        token: headers.get(SERVICE_TOKEN_HEADER_NAME),
        authorization: headers.get("authorization"),
      };

      if (request.named) {
        // The login endpoints are the server's on every origin it serves,
        // this one included: it is where a browser logs in to it.
        if (previews && isLoginEndpoint(url.pathname)) {
          return { kind: "not-mine" };
        }
        return authorizeNamed(request, request.named, upgrade);
      }

      const preview = previewClaim(request);
      if (preview) {
        const { route } = preview;
        // A worker script served from the root would claim every preview
        // on the host, not just this one's.
        if (
          preview.cookie &&
          !upgrade &&
          headers.get("service-worker") === "script"
        ) {
          return { kind: "refuse", surface: "preview", status: 404 };
        }
        if (!(await hasSession(headers.get("cookie"), url, secretKey))) {
          // A page load logs in and comes back to the same path, whether
          // the preview's own or one its cookie routes.
          if (
            !upgrade &&
            request.method === "GET" &&
            headers.get("sec-fetch-mode") === "navigate"
          ) {
            return {
              kind: "login",
              location: loginLocation(url, preview.cookie ? route : undefined),
            };
          }
          return {
            kind: "refuse",
            surface: "preview",
            status: 401,
            hint: "Open the preview in a browser to log in through Amika, or send a service token to the rig's service route.",
          };
        }
        if (!isOwnOrPageLoad(request, { upgrade })) {
          return { kind: "refuse", surface: "preview", status: 403 };
        }
        // Opening a preview hands its root-relative URLs to this service,
        // and a page load the cookie routes renews that cookie.
        return forward("preview", route, {
          setCookies: upgrade ? [] : previewCookies(request, route),
        });
      }

      const route = parseServicePath(url.pathname);
      if (!route) return { kind: "not-mine" };
      // amikad's SSH upgrade may skip the key; a keyed request is the
      // control plane's and routes like any other.
      const keyless =
        upgrade &&
        isAmikadSshUpgrade(request) &&
        authorizeServiceRequest(secretKey, credentials) === 401;
      const refusal = await authorizeServiceRouteRequest(
        secretKey,
        route,
        credentials,
        { requireKey: !keyless },
      );
      if (refusal) {
        return {
          kind: "refuse",
          surface: "service",
          status: refusal,
          ...(refusal === 401 ? tokenHint(route, credentials.token) : {}),
        };
      }
      return forward("service", route, { keyless, setCookies: [] });
    },

    /** The HTTP answer to a refusal. */
    refusal(decision: RefuseDecision): Response {
      const response =
        decision.status === 401
          ? // Close the connection so Node stops reading an unauthenticated
            // body.
            Response.json(
              {
                error: "Unauthorized",
                ...(decision.hint ? { hint: decision.hint } : {}),
              },
              { status: 401, headers: { Connection: "close" } },
            )
          : decision.status === 400
            ? Response.json(
                {
                  error: `Send the host key in ${SERVICE_KEY_HEADER}, not Authorization, which is forwarded to the guest`,
                },
                { status: 400 },
              )
            : decision.status === 403
              ? Response.json(
                  {
                    error:
                      decision.reason ??
                      "Forbidden: not a request from this preview",
                  },
                  { status: 403 },
                )
              : Response.json({ error: "Not found" }, { status: 404 });
      return harden(decision, response);
    },

    harden,

    /**
     * A forwarded service's response, without any cookie of ours the guest
     * tried to set, and with the decision's.
     */
    finish(decision: ForwardDecision, response: Response): Response {
      const headers = response.headers;
      const guest = headers.getSetCookie();
      if (guest.some(setsGatewayCookie)) {
        headers.delete("set-cookie");
        for (const cookie of guest) {
          if (!setsGatewayCookie(cookie)) headers.append("set-cookie", cookie);
        }
      }
      for (const cookie of decision.setCookies) {
        headers.append("set-cookie", cookie);
      }
      return harden(decision, response);
    },

    /**
     * `finish` for an upgrade, which the server tunnels as bytes: the
     * guest's raw answer to the handshake (its status line and header
     * lines, without the blank line that ends them), less any cookie of
     * ours it tries to set. A folded header line goes with the one it
     * continues.
     */
    finishUpgrade(head: string): string {
      const fields: string[][] = [];
      for (const line of head.split("\r\n")) {
        const last = fields.at(-1);
        if (last && fields.length > 1 && /^[ \t]/.test(line)) last.push(line);
        else fields.push([line]);
      }
      return fields
        .filter(([first, ...folded], i) => {
          if (i === 0) return true; // The status line.
          const colon = first.indexOf(":");
          if (
            colon < 0 ||
            first.slice(0, colon).trim().toLowerCase() !== "set-cookie"
          ) {
            return true;
          }
          const value = [first.slice(colon + 1), ...folded].join(" ");
          return !setsGatewayCookie(value);
        })
        .flat()
        .join("\r\n");
    },

    /** The HTTP answer to a login decision. */
    login(decision: LoginDecision): Response {
      return loginRedirect(decision.location);
    },

    /** Whether this gateway serves previews, behind a browser login. */
    servesPreviews: previews,

    /**
     * `GET /__amika/login`: send the browser to Amika's authorize page for
     * this host. Only with `amikaUrl`.
     */
    startLogin(request: Request): Response {
      if (amikaUrl === undefined) throw new Error("No previews to log in to");
      return startLogin(request, amikaUrl);
    },

    /**
     * `POST /__amika/callback`: check the pass Amika posted and set the
     * session.
     */
    finishLogin(request: Request): Promise<Response> {
      return finishLogin(request, secretKey, loginStates);
    },

    /** Whether a request header (lowercased) is a credential of ours. */
    isCredentialHeader(name: string): boolean {
      return name === SERVICE_KEY_HEADER || name === SERVICE_TOKEN_HEADER_NAME;
    },

    /** Whether a `Cookie` header may carry a cookie of ours. */
    carriesCredentialCookie(cookieHeader: string): boolean {
      return carriesGatewayCookie(cookieHeader);
    },

    /** A `Cookie` header without our cookies, or null when nothing is left. */
    guestCookies(cookieHeader: string | null | undefined): string | null {
      return withoutGatewayCookies(cookieHeader);
    },

    /**
     * The host key check alone, for a request no route claims: 401 without
     * the key in `X-Amika-Hostd-Key`, 400 with it also in `Authorization`.
     */
    checkHostKey(headers: Headers): 400 | 401 | null {
      return authorizeServiceRequest(secretKey, {
        key: headers.get(SERVICE_KEY_HEADER),
        authorization: headers.get("authorization"),
      });
    },
  };

  /**
   * Who may have a request its server named by hostname. The path is the
   * guest's, whole: the origin already says which service it is for.
   *
   * A browser session for this origin, and nothing else. The host key and a
   * service token travel in `x-amika-` headers, and every hop in front of a
   * named request (the reverse proxy, then the gateway) removes those from
   * what a caller sends, so neither could arrive here: a scripted caller
   * uses the service route instead. A browser without a session logs in at
   * this origin and comes back to the same path. The login endpoints never
   * reach here (`isLoginEndpoint`).
   */
  async function authorizeNamed(
    request: GatewayRequest,
    named: NamedService,
    upgrade: boolean,
  ): Promise<GatewayDecision> {
    const { url, headers } = request;
    const route = {
      machine: named.machine,
      service: named.service,
      path: url.pathname,
    };
    // amikad runs commands in the rig and has no preview. A browser session,
    // which every member of the organization can get, must not reach it at
    // its name. Only its SSH upgrade does, without the key as at its service
    // route: a tunnel host has no other address a client can dial, and
    // amikad checks the connect token before it accepts the WebSocket.
    if (named.service === AMIKAD_SERVICE) {
      if (upgrade && isNamedAmikadSshUpgrade(request)) {
        return forward("service", route, { keyless: true, setCookies: [] });
      }
      return { kind: "refuse", surface: "service", status: 404 };
    }
    const auth = named.auth ?? "organization";
    // A public service does its own login. Every request reaches it as the
    // caller sent it, with its `Authorization`, so an app on another origin
    // (a desktop app, a hosted web app) can pair with it: that app cannot
    // carry a session of ours, and its CORS preflight has to reach the
    // service to be answered. It is a service, not a preview, so its
    // answers are not hardened as one.
    if (auth === "public") {
      return forward("service", route, { setCookies: [] });
    }
    // Every rig of every organization shares the zone, so another
    // organization's rig is the same site as this one, and the `Lax`
    // session goes with what its pages load. A page load from there is a
    // link followed; anything else it loads here (a frame, which could be
    // laid invisibly over its own page, or a script) is refused, session
    // or not.
    const site = headers.get("sec-fetch-site");
    if (
      !upgrade &&
      (site === "same-site" || site === "cross-site") &&
      headers.get("sec-fetch-dest") !== "document"
    ) {
      return { kind: "refuse", surface: "preview", status: 403 };
    }
    if (!previews) {
      return {
        kind: "refuse",
        surface: "preview",
        status: 401,
        hint: "This host serves no browser login. Reach the service at its service route with a service token.",
      };
    }
    const user = await sessionUser(headers.get("cookie"), url, secretKey);
    if (user === null) {
      if (
        !upgrade &&
        request.method === "GET" &&
        headers.get("sec-fetch-mode") === "navigate"
      ) {
        return { kind: "login", location: loginLocation(url) };
      }
      return {
        kind: "refuse",
        surface: "preview",
        status: 401,
        hint: "Open the page in a browser to log in through Amika. A scripted caller uses the service route with a service token.",
      };
    }
    // A session says who logged in. The login admits every member of the
    // organization, so `owner` compares the user with the rig's owner. A
    // rig whose owner the server never named admits nobody this way.
    switch (auth) {
      case "organization":
        break;
      case "owner":
        if (user !== named.owner) {
          return {
            kind: "refuse",
            surface: "preview",
            status: 403,
            reason: "Forbidden: this rig belongs to another user",
          };
        }
        break;
      default:
        assertNever(auth);
    }
    // Only this origin's own requests, and page loads, are let through.
    if (!isOwnOrPageLoad(request, { upgrade })) {
      return { kind: "refuse", surface: "preview", status: 403 };
    }
    return forward("preview", route, { setCookies: [] });
  }

  /**
   * `response` as its surface's must be: a preview's hardened, as is every
   * answer there, the server's own `404`s and `502`s included.
   */
  function harden(
    decision: ForwardDecision | RefuseDecision,
    response: Response,
  ): Response {
    switch (decision.surface) {
      case "preview":
        return hardenPreviewResponse(response);
      case "service":
        return response;
      default: {
        const exhaustive: never = decision.surface;
        throw new Error(`Unexpected surface: ${String(exhaustive)}`);
      }
    }
  }

  function isLoginEndpoint(pathname: string): boolean {
    return pathname === LOGIN_PATH || pathname === CALLBACK_PATH;
  }

  function forward(
    surface: GatewaySurface,
    route: ServiceRoute,
    {
      keyless = false,
      setCookies,
    }: { keyless?: boolean; setCookies: string[] },
  ): ForwardDecision {
    return {
      kind: "forward",
      surface,
      route: {
        machine: route.machine,
        service: route.service,
        path: route.path,
      },
      keyless,
      setCookies,
    };
  }
}

function assertNever(value: never): never {
  throw new Error(`unhandled case: ${String(value)}`);
}

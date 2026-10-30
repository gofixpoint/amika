/** Sandbox resources backed by an Amika host daemon's versioned rig API. */
import { DEFAULT_HOME_DIR } from "../../constants";
import type { AmikaHostdConfig } from "./config";
import { amikaHostdCapabilities } from "./capabilities";
import type { SandboxProvider } from "../provider";
import type { SandboxAdapter } from "../shared/adapter";
import { defineProvider } from "../shared/define-provider";
import {
  SmolApiError,
  SmolClient,
  mapSmolState,
  smolOperations,
} from "../smol/provider";
import {
  HOSTD_API_VERSION,
  HOSTD_RIGS_PATH,
  HOSTD_SERVICE_URL_TTL_S,
  hostdServiceRoutes,
  refusedAccessSettings,
  hostdServices,
} from "./internal/services";
import { HOSTD_SNAPSHOTS_PATH, hostdSnapshots } from "./internal/snapshots";

// Callers of amikad's hostd service URL (the control plane) must present the
// host's secret key in this header; every other service URL is a preview,
// which a browser logs in to. See `./internal/services`.
export { HOSTD_SERVICE_KEY_HEADER } from "./internal/services";

interface AmikaHostdDeps {
  config: AmikaHostdConfig;
  fetcher?: typeof fetch;
}

/**
 * Smol's machine operations over hostd, which serves a superset of smolvm's
 * API, plus the service routes only hostd provides.
 */
export default function amikaHostdProvider({
  config,
  fetcher = fetch,
}: AmikaHostdDeps): SandboxProvider {
  return createProvider({ config, fetcher });
}

const createProvider = defineProvider(
  amikaHostdCapabilities,
  ({
    config: { secretKey, ...config },
    fetcher,
  }: {
    config: AmikaHostdConfig;
    fetcher: typeof fetch;
  }) => {
    const smolConfig = {
      ...config,
      network: config.network ?? true,
      apiUrl: config.apiUrl ?? "http://127.0.0.1:3020",
      requestTimeoutMs: config.requestTimeoutMs ?? 310_000,
    };
    const authenticated = withSecretKey(secretKey, fetcher);
    const client = new SmolClient(smolConfig, authenticated, HOSTD_RIGS_PATH);
    // The host's snapshots are its own collection, not a rig's, so they need
    // a client addressing that path rather than `/v0beta1/rigs`.
    const snapshotClient = new SmolClient(
      smolConfig,
      authenticated,
      HOSTD_SNAPSHOTS_PATH,
    );
    const ops = smolOperations(smolConfig, client, {
      provider: "amika-hostd",
      serviceRoutes: hostdServiceRoutes,
    });
    return {
      name: "amika-hostd",
      signedUrlTtlSeconds: HOSTD_SERVICE_URL_TTL_S,
      userHomeDir: DEFAULT_HOME_DIR,
      sandbox: {
        create: async (_ctx, input) => {
          try {
            return await ops.create(input);
          } catch (error) {
            // The collection itself missing means the host predates v0beta1.
            if (
              error instanceof SmolApiError &&
              error.status === 404 &&
              error.method === "POST" &&
              error.path === ""
            ) {
              throw new Error(
                `amika-hostd at ${smolConfig.apiUrl} does not serve API ${HOSTD_API_VERSION}; upgrade amika-hostd on that host`,
                { cause: error },
              );
            }
            // A host from before `service-access` refuses a body that says
            // what a service is at its name, rather than serving it as if
            // it had said nothing.
            throw (
              refusedAccessSettings(
                error,
                hostdServiceRoutes(input.services),
                smolConfig.apiUrl,
              ) ?? error
            );
          }
        },
        delete: ops.remove,
        start: ops.start,
        stop: ops.stop,
        getState: ops.getState,
        mapState: mapSmolState,
      },
      exec: { stdin: true, run: ops.run },
      files: { read: ops.read, write: ops.write },
      listing: { list: ops.list },
      services: hostdServices(smolConfig.apiUrl, client),
      snapshots: hostdSnapshots({ rigs: client, snapshots: snapshotClient }),
    };
  },
);

/** Provision through the same public sandbox methods as other consumers. */
export async function openAmikaHostdAdapter(
  config: AmikaHostdConfig,
  id: string,
  fetcher = fetch,
): Promise<SandboxAdapter> {
  const sandbox = amikaHostdProvider({ config, fetcher }).sandboxes.get(id);
  return {
    exec: (command, opts) => sandbox.exec(command, opts),
    uploadFile: (content, path) => sandbox.writeFile(path, content),
    downloadFile: (path) => sandbox.readFile(path),
  };
}

/**
 * Authenticate every daemon request, whatever headers Smol already set.
 * Redirects are refused: a `307` would resend the request body, which for
 * exec carries commands, environment, and stdin, to another location.
 */
export function withSecretKey(
  secretKey: string,
  fetcher: typeof fetch,
): typeof fetch {
  return (input, init) => {
    // As in `fetch`, init headers replace a Request's own; absent, keep them.
    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    );
    headers.set("Authorization", `Bearer ${secretKey}`);
    return fetcher(input, { ...init, headers, redirect: "error" });
  };
}

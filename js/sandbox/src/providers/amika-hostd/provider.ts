/** Sandbox resources backed by an Amika host daemon's versioned rig API. */
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
  hostdServices,
} from "./internal/services";

// Callers of a hostd service URL (the control plane) must present the host's
// secret key in this header; see `./internal/services`.
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
    const client = new SmolClient(
      smolConfig,
      withSecretKey(secretKey, fetcher),
      HOSTD_RIGS_PATH,
    );
    const ops = smolOperations(smolConfig, client, {
      provider: "amika-hostd",
      serviceRoutes: hostdServiceRoutes,
    });
    return {
      name: "amika-hostd",
      signedUrlTtlSeconds: HOSTD_SERVICE_URL_TTL_S,
      userHomeDir: "/root",
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
            throw error;
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

/** Sandbox resources backed by an Amika host daemon's Smol-compatible API. */
import type { AmikaHostdConfig } from "./config";
import { amikaHostdCapabilities } from "./capabilities";
import {
  SandboxProviderUnsupportedError,
  type Sandbox,
  type SandboxProvider,
} from "../provider";
import type { SandboxAdapter } from "../shared/adapter";
import smolProvider from "../smol/provider";

interface AmikaHostdDeps {
  config: AmikaHostdConfig;
  fetcher?: typeof fetch;
}

/** Compose the public Smol resource API without depending on its implementation. */
export default function amikaHostdProvider({
  config: { secretKey, ...config },
  fetcher = fetch,
}: AmikaHostdDeps): SandboxProvider {
  const smol = smolProvider(
    {
      ...config,
      network: config.network ?? true,
      apiUrl: config.apiUrl ?? "http://127.0.0.1:3020",
      requestTimeoutMs: config.requestTimeoutMs ?? 310_000,
    },
    withSecretKey(secretKey, fetcher),
  );
  return {
    ...smol,
    name: "amika-hostd",
    capabilities: amikaHostdCapabilities,
    sandboxes: {
      create: (ctx, input) =>
        withHostdErrors(async () =>
          hostdSandbox(await smol.sandboxes.create(ctx, input)),
        ),
      get: (id) => hostdSandbox(smol.sandboxes.get(id)),
      list: () => withHostdErrors(() => smol.sandboxes.list()),
    },
  };
}

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

function hostdSandbox(sandbox: Sandbox): Sandbox {
  return {
    ...sandbox,
    provider: "amika-hostd",
    created: sandbox.created && { ...sandbox.created, provider: "amika-hostd" },
    start: (interval) => withHostdErrors(() => sandbox.start(interval)),
    stop: () => withHostdErrors(() => sandbox.stop()),
    delete: () => withHostdErrors(() => sandbox.delete()),
    getState: () => withHostdErrors(() => sandbox.getState()),
    getRuntimeState: () => withHostdErrors(() => sandbox.getRuntimeState()),
    exec: (command, opts) => withHostdErrors(() => sandbox.exec(command, opts)),
    streamExec: (command, handlers) =>
      withHostdErrors(() => sandbox.streamExec(command, handlers)),
    readFile: (path) => withHostdErrors(() => sandbox.readFile(path)),
    writeFile: (path, content) =>
      withHostdErrors(() => sandbox.writeFile(path, content)),
  };
}

/** Keep unsupported-operation errors scoped to the provider the caller selected. */
async function withHostdErrors<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof SandboxProviderUnsupportedError) {
      throw new SandboxProviderUnsupportedError("amika-hostd", error.operation);
    }
    throw error;
  }
}

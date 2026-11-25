/**
 * The boxd SDK client (`@boxd-sh/sdk`). boxd's API is gRPC only
 * (`boxd.api.v1.BoxdApi` at `boxd.sh:9443`, https://docs.boxd.sh/reference/grpc-api),
 * so this provider uses boxd's own client instead of a fetch client.
 *
 * One client per key is kept, because a client holds the key's session
 * token and its gRPC connections.
 */
import { Boxd } from "@boxd-sh/sdk";
import type { BoxdConfig } from "../config";

const clients = new Map<string, Boxd>();

export function boxdClient(config: BoxdConfig): Boxd {
  const key = `${config.apiUrl ?? ""}\0${config.apiKey}`;
  let client = clients.get(key);
  if (!client) {
    client = new Boxd({
      apiKey: config.apiKey,
      ...(config.apiUrl ? { baseURL: config.apiUrl } : {}),
    });
    clients.set(key, client);
  }
  return client;
}

/** True when `error` is the SDK's not-found error. */
export function isNotFound(error: unknown): boolean {
  return (error as { name?: string })?.name === "NotFoundError";
}

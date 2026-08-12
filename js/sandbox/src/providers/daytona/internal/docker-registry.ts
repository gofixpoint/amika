/**
 * Direct HTTP client for the Daytona Docker Registry API.
 *
 * The Daytona SDK does not expose registry management, so these functions
 * call the REST API directly using fetch().
 */
import type { DaytonaConfig } from "../config";
import type {
  CreateDockerRegistryInput,
  ProviderDockerRegistry,
} from "../../provider";

// The registry shapes are provider-agnostic (defined in `../provider`),
// re-exported under a Daytona name for the package index.
export type { CreateDockerRegistryInput } from "../../provider";
export type DaytonaDockerRegistry = ProviderDockerRegistry;

function registryUrl(config: DaytonaConfig, path: string): string {
  const base = config.apiUrl.replace(/\/+$/, "");
  return `${base}/docker-registry${path}`;
}

function headers(config: DaytonaConfig): Record<string, string> {
  const requestHeaders: Record<string, string> = {
    Authorization: `Bearer ${config.apiKey}`,
    "Content-Type": "application/json",
  };
  if (config.organizationId) {
    requestHeaders["X-Daytona-Organization-ID"] = config.organizationId;
  }
  return requestHeaders;
}

async function handleResponse<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `Daytona Docker Registry API error: ${res.status} ${res.statusText}${body ? ` — ${body}` : ""}`,
    );
  }
  return res.json() as Promise<T>;
}

export async function createDaytonaDockerRegistry(
  config: DaytonaConfig,
  input: CreateDockerRegistryInput,
): Promise<DaytonaDockerRegistry> {
  const res = await fetch(registryUrl(config, ""), {
    method: "POST",
    headers: headers(config),
    body: JSON.stringify(input),
  });
  return handleResponse<DaytonaDockerRegistry>(res);
}

export async function listDaytonaDockerRegistries(
  config: DaytonaConfig,
): Promise<DaytonaDockerRegistry[]> {
  const res = await fetch(registryUrl(config, ""), {
    method: "GET",
    headers: headers(config),
  });
  return handleResponse<DaytonaDockerRegistry[]>(res);
}

export async function getDaytonaDockerRegistry(
  config: DaytonaConfig,
  registryId: string,
): Promise<DaytonaDockerRegistry> {
  const res = await fetch(registryUrl(config, `/${registryId}`), {
    method: "GET",
    headers: headers(config),
  });
  return handleResponse<DaytonaDockerRegistry>(res);
}

export async function deleteDaytonaDockerRegistry(
  config: DaytonaConfig,
  registryId: string,
): Promise<void> {
  const res = await fetch(registryUrl(config, `/${registryId}`), {
    method: "DELETE",
    headers: headers(config),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `Daytona Docker Registry API error: ${res.status} ${res.statusText}${body ? ` — ${body}` : ""}`,
    );
  }
}

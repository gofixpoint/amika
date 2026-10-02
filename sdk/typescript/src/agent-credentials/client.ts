import { type HTTPClient } from "../internal/http.js";
import {
  type AgentCredentials,
  type CreateProviderSecretRequest,
  type ProviderSecretSummary,
  type ProviderSecretListItem,
} from "./types.js";
import { API_BASE_PATH } from "../internal/constants.js";

export function createAgentCredentials(http: HTTPClient): AgentCredentials {
  return new AgentCredentialsClient(http);
}

class AgentCredentialsClient implements AgentCredentials {
  constructor(private readonly http: HTTPClient) {}
  async create(
    provider: string,
    req: CreateProviderSecretRequest,
  ): Promise<ProviderSecretSummary> {
    const data = await this.http.doJSON<ProviderSecretSummary>(
      "POST",
      `${API_BASE_PATH}/secrets/${encodeURIComponent(provider)}`,
      req,
    );
    return data ?? { id: "", name: "", scope: "" };
  }

  async list(provider: string): Promise<ProviderSecretListItem[]> {
    const data =
      (await this.http.doJSON<ProviderSecretListItem[]>(
        "GET",
        `${API_BASE_PATH}/secrets/${encodeURIComponent(provider)}`,
      )) ?? [];
    return data;
  }

  async delete(provider: string, id: string): Promise<void> {
    await this.http.doJSON(
      "DELETE",
      `${API_BASE_PATH}/secrets/${encodeURIComponent(provider)}/${encodeURIComponent(id)}`,
    );
  }
}

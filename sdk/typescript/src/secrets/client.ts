import { type HTTPClient } from "../internal/http.js";
import {
  type Secrets,
  type Secret,
  type CreateSecretRequest,
  type UpdateSecretRequest,
} from "./types.js";
import { API_BASE_PATH } from "../internal/constants.js";
import { mapArray } from "../internal/wire.js";
import { secretFromWire } from "./wire.js";

export function createSecrets(http: HTTPClient): Secrets {
  return new SecretsClient(http);
}

class SecretsClient implements Secrets {
  constructor(private readonly http: HTTPClient) {}
  async list(): Promise<Secret[]> {
    const data = await this.http.doJSON<unknown[]>(
      "GET",
      `${API_BASE_PATH}/secrets`,
    );
    return mapArray(data, secretFromWire);
  }

  async create(req: CreateSecretRequest): Promise<void> {
    await this.http.doJSON("POST", `${API_BASE_PATH}/secrets`, req);
  }

  async update(id: string, req: UpdateSecretRequest): Promise<void> {
    await this.http.doJSON(
      "PUT",
      `${API_BASE_PATH}/secrets/${encodeURIComponent(id)}`,
      req,
    );
  }
}

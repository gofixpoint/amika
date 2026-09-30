import { type HTTPClient } from "../internal/http.js";
import { type Repositories, type RemoteRepository } from "./types.js";
import { API_BASE_PATH } from "../internal/constants.js";
import { mapArray } from "../internal/wire.js";
import { remoteRepositoryFromWire } from "./wire.js";

export function createRepositories(http: HTTPClient): Repositories {
  return new RepositoriesClient(http);
}

class RepositoriesClient implements Repositories {
  constructor(private readonly http: HTTPClient) {}
  async list(): Promise<RemoteRepository[]> {
    const data = await this.http.doJSON<unknown[]>(
      "GET",
      `${API_BASE_PATH}/repositories`,
    );
    return mapArray(data, remoteRepositoryFromWire);
  }
}

import { type RemoteRepository } from "./types.js";
import { str } from "../internal/wire.js";

export function remoteRepositoryFromWire(
  w: Record<string, unknown>,
): RemoteRepository {
  return {
    id: str(w["id"]),
    repoUrl: str(w["repo_url"]),
  };
}

import { type HTTPClient } from "../internal/http.js";
import {
  type RigSessions,
  type CreateSessionRequest,
  type Session,
  type UpdateSessionRequest,
} from "./types.js";
import { API_BASE_PATH } from "../internal/constants.js";
import {
  createSessionRequestToWire,
  sessionFromWire,
  updateSessionRequestToWire,
} from "./wire.js";
import { AmikaHTTPError } from "../errors.js";

export function createRigSessions(http: HTTPClient): RigSessions {
  return new RigSessionsClient(http);
}

class RigSessionsClient implements RigSessions {
  constructor(private readonly http: HTTPClient) {}
  async create(rigName: string, req: CreateSessionRequest): Promise<Session> {
    const data = await this.http.doJSON<Record<string, unknown>>(
      "POST",
      `${API_BASE_PATH}/rigs/${encodeURIComponent(rigName)}/sessions`,
      createSessionRequestToWire(req),
    );
    return sessionFromWire(data ?? {});
  }

  async list(rigName: string): Promise<Session[]> {
    const envelope = await this.http.doJSON<{
      sessions?: Record<string, unknown>[];
    }>("GET", `${API_BASE_PATH}/rigs/${encodeURIComponent(rigName)}/sessions`);
    const sessions = envelope?.sessions ?? [];
    return sessions.map((s) => sessionFromWire(s));
  }

  async latest(rigName: string): Promise<Session | null> {
    try {
      const data = await this.http.doJSON<Record<string, unknown>>(
        "GET",
        `${API_BASE_PATH}/rigs/${encodeURIComponent(rigName)}/sessions/latest`,
      );
      return sessionFromWire(data ?? {});
    } catch (err) {
      if (err instanceof AmikaHTTPError && err.statusCode === 404) return null;
      throw err;
    }
  }

  async get(rigName: string, sessionId: string): Promise<Session> {
    const data = await this.http.doJSON<Record<string, unknown>>(
      "GET",
      `${API_BASE_PATH}/rigs/${encodeURIComponent(rigName)}/sessions/${encodeURIComponent(sessionId)}`,
    );
    return sessionFromWire(data ?? {});
  }

  async update(
    rigName: string,
    sessionId: string,
    req: UpdateSessionRequest,
  ): Promise<Session> {
    const data = await this.http.doJSON<Record<string, unknown>>(
      "PATCH",
      `${API_BASE_PATH}/rigs/${encodeURIComponent(rigName)}/sessions/${encodeURIComponent(sessionId)}`,
      updateSessionRequestToWire(req),
    );
    return sessionFromWire(data ?? {});
  }
}

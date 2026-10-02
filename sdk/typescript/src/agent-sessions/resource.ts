import type {
  AgentSession,
  AgentSessionDetail,
  AgentSessions,
} from "./types.js";
import { bindOperations } from "../internal/resource.js";

export function createAgentSessionResource(
  data: AgentSessionDetail,
  client: AgentSessions,
): AgentSession {
  const id = data.sessionId;
  const session: AgentSession = bindOperations(data, {
    refresh: async () => {
      Object.assign(session, await client.get(id));
      return session;
    },
    send: (request: Parameters<AgentSession["send"]>[0]) =>
      client.send({ ...request, sessionId: id }),
    sendStream: (
      request: Parameters<AgentSession["sendStream"]>[0],
      handlers?: Parameters<AgentSession["sendStream"]>[1],
    ) => client.sendStream({ ...request, sessionId: id }, handlers),
  });
  return session;
}

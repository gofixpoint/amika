/**
 * Who may reach a rig's service, decided per request: the host key, service
 * tokens and browser sessions on previews. See `./gateway.ts`.
 */
export {
  createGateway,
  type ForwardDecision,
  type Gateway,
  type GatewayDecision,
  type GatewayOptions,
  type GatewaySurface,
  type LoginDecision,
  type RefuseDecision,
} from "./gateway";
export {
  SERVICE_KEY_HEADER,
  SERVICE_TOKEN_HEADER_NAME,
  authorizeServiceRequest,
  authorizeServiceRouteRequest,
  bearerToken,
  secretMatches,
} from "./keys";
export {
  LINK_COOKIE,
  LOGIN_STATE_COOKIE,
  PREVIEW_COOKIE,
  SESSION_COOKIE,
  carriesGatewayCookie,
  isLoopbackHost,
  withoutGatewayCookies,
} from "./cookies";
export { tokenHint } from "./responses";
export {
  AMIKAD_SERVICE,
  SERVICE_AUTH_MODES,
  fromRequest,
  isAmikadSshUpgrade,
  parseServicePath,
  type GatewayRequest,
  type NamedService,
  type ServiceAuth,
  type ServiceRoute,
} from "./routes";
export {
  browserOrigin,
  hardenPreviewResponse,
  parsePreviewPath,
  privateCacheControl,
} from "./browser-login";

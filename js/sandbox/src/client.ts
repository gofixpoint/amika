/**
 * Client-safe entry (`@amika/sandbox/client`).
 *
 * The only surface a browser bundle may import: pure metadata + sizing helpers
 * and value lists, with NO provider SDK, `node:` built-in, or `server-only`
 * dependency in its module graph. React components and any other
 * client-reachable module must import from here, never from the `.` barrel
 * (which pulls in the provider SDKs).
 */
export * from "./providers/capabilities";
export {
  freestyleSizingForSize,
  type FreestyleSizing,
} from "./providers/freestyle/sizing";
export {
  vercelSizingForSize,
  vercelVcpusForSize,
  type VercelSizing,
} from "./providers/vercel/sizing";
// Pure Freestyle naming helpers (no SDK): reachable from client- and
// edge-runtime code, so they must come through this SDK-free entry rather than
// the root barrel.
export {
  buildFreestyleSnapshotName,
  buildFreestyleVmName,
  freestyleVmNameOrgId,
  freestyleVmBelongsToOrg,
} from "./providers/freestyle/naming";
export * from "./enums";
// On-box runtime constants (reserved ports, lifecycle script paths, ownership
// labels, size specs) are plain values with no SDK/`node:` dependency, so
// client- and edge-reachable code can re-export them from here as the single
// source of truth for these on-box contracts.
export * from "./constants";

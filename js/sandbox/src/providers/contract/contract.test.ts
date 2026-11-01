/**
 * Runs the provider contract against `simulate`. This keeps the suite itself
 * honest on every `pnpm test` and makes `simulate` the reference provider.
 *
 * `simulate` has no shell, so the suite's commands are scripted into its world
 * through `scriptExec`; against a real vendor the same commands really run.
 */
import { createSandboxProvider } from "../registry";
import { getSimulateWorld } from "../simulate/provider";
import { describeProviderContract } from "./contract";

const WORLD_ID = "provider-contract";

describeProviderContract({
  createProvider: (resolveSnapshotId) =>
    createSandboxProvider("simulate", {
      daytona: { apiKey: "", apiUrl: "" },
      e2b: null,
      freestyle: null,
      vercel: null,
      smol: null,
      amikaHostd: null,
      simulate: { worldId: WORLD_ID },
      resolveSnapshotId,
    }),
  bootSnapshot: "base",
  scriptExec: (command, result) =>
    getSimulateWorld(WORLD_ID).onExec(command, result),
});

import { z } from "zod";
import type { ProviderSpendItem, ProviderSpendWindow } from "../../provider";
import type { SailboxConfig } from "../config";
import { sailboxApiUrl } from "./client";

const USD_NANOS = 1_000_000_000;

const spendItemSchema = z.object({
  sailbox_id: z.string().min(1),
  finalized_cost_usd_nanos: z.number().int().nonnegative(),
  estimated_active_cost_usd_nanos: z.number().int().nonnegative(),
  estimated_total_cost_usd_nanos: z.number().int().nonnegative(),
  duration_seconds: z.number().int().nonnegative(),
  vcpu_seconds: z.number().nonnegative(),
  memory_gib_seconds: z.number().nonnegative(),
  state_disk_gib_seconds: z.number().nonnegative(),
  active: z.boolean(),
});

const spendResponseSchema = z.object({
  rates: z
    .object({
      vcpu_second_usd_nanos: z.number().int().nonnegative(),
      memory_gib_second_usd_nanos: z.number().int().nonnegative(),
      state_disk_gib_second_usd_nanos: z.number().int().nonnegative(),
    })
    .passthrough(),
  sailboxes: z.array(spendItemSchema),
});

/** Read Sail's observed resource usage and estimated bill for one time window. */
export async function reportSailboxSpend(
  config: SailboxConfig,
  window: ProviderSpendWindow,
): Promise<ProviderSpendItem[]> {
  const response = await fetch(spendUrl(config, window), {
    headers: { Authorization: `Bearer ${config.apiKey}` },
  });
  if (!response.ok) {
    throw new Error(
      `Sailbox spend report failed (${response.status} ${response.statusText})`,
    );
  }

  const report = spendResponseSchema.parse(await response.json());
  return report.sailboxes.map((item) => ({
    providerSandboxId: item.sailbox_id,
    state: item.active ? "active" : "finalized",
    durationSeconds: item.duration_seconds,
    vcpuSeconds: item.vcpu_seconds,
    memoryGibSeconds: item.memory_gib_seconds,
    diskGibSeconds: item.state_disk_gib_seconds,
    cpuDollars:
      (item.vcpu_seconds * report.rates.vcpu_second_usd_nanos) / USD_NANOS,
    memoryDollars:
      (item.memory_gib_seconds * report.rates.memory_gib_second_usd_nanos) /
      USD_NANOS,
    diskDollars:
      (item.state_disk_gib_seconds *
        report.rates.state_disk_gib_second_usd_nanos) /
      USD_NANOS,
    amountDollars: item.estimated_total_cost_usd_nanos / USD_NANOS,
  }));
}

function spendUrl(config: SailboxConfig, window: ProviderSpendWindow): string {
  const url = new URL(
    `${sailboxApiUrl(config).replace(/\/$/, "")}/sailboxes/spend`,
  );
  url.searchParams.set("from", window.from.toISOString());
  url.searchParams.set("to", window.to.toISOString());
  return url.toString();
}

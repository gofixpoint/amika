/**
 * Turn a run's ledger into the summary a human reads: one row per resource
 * with its final outcome, as a plain-text table for stdout and as markdown
 * for a GitHub Actions step summary.
 */
import type { LedgerEvent, ResourceKind } from "./ledger";

export type Outcome = "deleted" | "deleted (unverified)" | "LEAKED";

export interface AuditRow {
  kind: ResourceKind;
  provider: string;
  id: string;
  /** The provider's own id, when it was learned after the resource was recorded. */
  providerId?: string;
  name: string;
  test: string;
  outcome: Outcome;
  /** The error for a leak; empty otherwise. */
  detail: string;
}

export interface AuditSummary {
  rows: AuditRow[];
  created: number;
  deleted: number;
  leaked: number;
}

/** Fold a ledger's events into one row per created resource. */
export function summarize(events: LedgerEvent[]): AuditSummary {
  const rows = new Map<string, AuditRow>();
  for (const event of events) {
    if (event.event === "run") continue;
    const key = `${event.kind}:${event.id}`;
    if (event.event === "created") {
      rows.set(key, {
        kind: event.kind,
        provider: event.provider,
        id: event.id,
        name: event.name,
        test: event.test,
        // A created line with no later outcome is a leak until proven otherwise.
        outcome: "LEAKED",
        detail: "no deletion recorded (run killed before cleanup?)",
      });
      continue;
    }
    const row = rows.get(key);
    if (!row) continue;
    if (event.event === "identified") {
      row.providerId = event.providerId;
    } else if (event.event === "deleted") {
      row.outcome =
        event.verified === true ? "deleted" : "deleted (unverified)";
      row.detail = "";
    } else {
      row.outcome = "LEAKED";
      row.detail = event.error;
    }
  }
  const all = [...rows.values()];
  return {
    rows: all,
    created: all.length,
    deleted: all.filter((r) => r.outcome !== "LEAKED").length,
    leaked: all.filter((r) => r.outcome === "LEAKED").length,
  };
}

const COLUMNS: Array<[string, (r: AuditRow) => string]> = [
  ["KIND", (r) => r.kind],
  ["PROVIDER", (r) => r.provider],
  ["ID", (r) => r.providerId ?? r.id],
  ["NAME", (r) => r.name],
  ["CREATED IN", (r) => r.test],
  ["OUTCOME", (r) => (r.detail ? `${r.outcome}: ${r.detail}` : r.outcome)],
];

/** The summary as an aligned text table with a totals line. */
export function renderText(
  summary: AuditSummary,
  heading: { runId: string; file: string },
): string {
  const lines = [`Provider contract audit  run=${heading.runId}`];
  if (summary.rows.length === 0) {
    lines.push("No resources were created.");
  } else {
    const cells = summary.rows.map((r) => COLUMNS.map(([, get]) => get(r)));
    const widths = COLUMNS.map(([title], i) =>
      Math.max(title.length, ...cells.map((row) => row[i].length)),
    );
    const pad = (row: string[]) =>
      row
        .map((cell, i) => cell.padEnd(widths[i]))
        .join("  ")
        .trimEnd();
    lines.push(pad(COLUMNS.map(([title]) => title)));
    for (const row of cells) lines.push(pad(row));
  }
  lines.push(totals(summary));
  lines.push(`Ledger: ${heading.file}`);
  return lines.join("\n");
}

/** The summary as a markdown table for `$GITHUB_STEP_SUMMARY`. */
export function renderMarkdown(
  summary: AuditSummary,
  heading: { runId: string },
): string {
  const lines = [`### Provider contract audit (run \`${heading.runId}\`)`, ""];
  if (summary.rows.length === 0) {
    lines.push("No resources were created.");
  } else {
    lines.push(`| ${COLUMNS.map(([title]) => title).join(" | ")} |`);
    lines.push(`| ${COLUMNS.map(() => "---").join(" | ")} |`);
    for (const row of summary.rows) {
      lines.push(
        `| ${COLUMNS.map(([, get]) => escapeCell(get(row))).join(" | ")} |`,
      );
    }
  }
  lines.push("", totals(summary));
  return lines.join("\n");
}

function totals(summary: AuditSummary): string {
  const leaked = summary.leaked > 0 ? `${summary.leaked} LEAKED` : "0 leaked";
  return `${summary.created} created, ${summary.deleted} deleted, ${leaked}`;
}

function escapeCell(text: string): string {
  return text.replaceAll("|", "\\|").replaceAll("\n", " ");
}

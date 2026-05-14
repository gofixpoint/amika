export type FlagValue = string | number | boolean | undefined;

export function pushFlag(args: string[], name: string, value: FlagValue): void {
  if (value === undefined || value === false) return;
  if (value === true) {
    args.push(name);
    return;
  }
  args.push(name, String(value));
}

export function pushRepeated(args: string[], name: string, values?: readonly string[]): void {
  if (!values) return;
  for (const v of values) {
    args.push(name, v);
  }
}

export function envRecordToFlags(args: string[], name: string, env?: Record<string, string>): void {
  if (!env) return;
  for (const [k, v] of Object.entries(env)) {
    args.push(name, `${k}=${v}`);
  }
}

export function scopeFlag(args: string[], scope?: "local" | "remote"): void {
  if (scope === "local") args.push("--local");
  if (scope === "remote") args.push("--remote");
}

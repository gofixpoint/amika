export function omitUndefined(
  obj: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

/** A schema-required, non-nullable string: null and absent both become "". */
export function str(v: unknown): string {
  return v === undefined || v === null ? "" : String(v);
}

/** A schema-nullable string: null and absent both become null. */
export function nullableStr(v: unknown): string | null {
  return v === undefined || v === null ? null : String(v);
}

/** An optional string: null and absent both become undefined. */
export function optionalStr(v: unknown): string | undefined {
  return v === undefined || v === null ? undefined : String(v);
}

export function num(v: unknown): number {
  return v === undefined || v === null ? 0 : Number(v);
}

export function nullableNum(v: unknown): number | null {
  return v === undefined || v === null ? null : Number(v);
}

export function optionalNum(v: unknown): number | undefined {
  return v === undefined || v === null ? undefined : Number(v);
}

export function bool(v: unknown): boolean {
  return Boolean(v);
}

export function optionalBool(v: unknown): boolean | undefined {
  return v === undefined || v === null ? undefined : Boolean(v);
}

export function strArray(v: unknown): string[] {
  return Array.isArray(v) ? v.map((item) => str(item)) : [];
}

export function optionalStrArray(v: unknown): string[] | undefined {
  return Array.isArray(v) ? v.map((item) => str(item)) : undefined;
}

export function mapArray<T>(
  v: unknown,
  from: (w: Record<string, unknown>) => T,
): T[] {
  return Array.isArray(v)
    ? v.map((item) => from(item as Record<string, unknown>))
    : [];
}

export function optionalArray<T>(
  v: unknown,
  from: (w: Record<string, unknown>) => T,
): T[] | undefined {
  return Array.isArray(v)
    ? v.map((item) => from(item as Record<string, unknown>))
    : undefined;
}

export function optionalObject<T>(
  v: unknown,
  from: (w: Record<string, unknown>) => T,
): T | undefined {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? from(v as Record<string, unknown>)
    : undefined;
}

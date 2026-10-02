/**
 * `T` with the keys in `K` made optional. Gives a legacy sandbox-named alias a
 * shape that accepts a literal predating the rig fields, while still admitting
 * every value the SDK decodes (which carries both spellings).
 */
export type LegacyShape<T, K extends keyof T> = Omit<T, K> &
  Partial<Pick<T, K>>;

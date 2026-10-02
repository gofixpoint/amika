/** Keep bound operations and their captured transport out of JSON and spreads. */
export function bindOperations<T extends object, O extends object>(
  data: T,
  operations: O,
): T & O {
  return Object.defineProperties(
    data,
    Object.fromEntries(
      Object.entries(operations).map(([name, value]) => [name, { value }]),
    ),
  ) as T & O;
}

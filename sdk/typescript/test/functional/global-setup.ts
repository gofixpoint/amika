import { assertNotProdUrl } from "./prod-guard";

/**
 * Vitest globalSetup for the functional runner. Runs once before any test file
 * loads, so a prod-pointed AMIKA_API_URL aborts the entire run before a single
 * network call is made.
 */
export function setup(): void {
  assertNotProdUrl(process.env["AMIKA_API_URL"]);
}

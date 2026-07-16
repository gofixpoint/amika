/**
 * Hard guard against running the deployed-service functional tests against
 * production. This is a blocklist of known production hosts with NO override
 * escape hatch: if AMIKA_API_URL points at prod, the functional run aborts.
 *
 * Everything else (staging, localhost, ephemeral preview deployments) is
 * allowed. Point AMIKA_API_URL at staging (e.g. https://app.staging-amika.dev)
 * to run the suite.
 */

/** Production hosts that functional tests must never target. */
const PROD_HOSTS = new Set(["app.amika.dev", "amika.dev"]);

/**
 * Throw if `url` resolves to a production host. A no-op when `url` is undefined
 * or empty: functional suites already skip (via describeFunctional) when
 * AMIKA_API_URL is unset, so there is nothing to guard.
 */
export function assertNotProdUrl(url?: string): void {
  if (!url) return;

  let host: string;
  try {
    // hostname already excludes the port; lowercase for a case-insensitive
    // comparison against the blocklist.
    host = new URL(url).hostname.toLowerCase();
  } catch {
    // Not a parseable URL. Let the SDK surface its own error rather than
    // masking it here; there is no prod host to block.
    return;
  }

  if (PROD_HOSTS.has(host)) {
    throw new Error(
      `Functional tests are banned against production (${host}). ` +
        "Point AMIKA_API_URL at staging instead " +
        "(e.g. https://app.staging-amika.dev). This ban has no override.",
    );
  }
}

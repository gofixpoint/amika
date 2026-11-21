import { type HTTPClient } from "../internal/http.js";
import { API_BASE_PATH } from "../internal/constants.js";
import {
  normalizeRef,
  queryString,
  refPathSegment,
  setRefSelector,
} from "../internal/resource-ref.js";
import { mapArray } from "../internal/wire.js";
import {
  type CloudAccountLookupOptions,
  type CloudAccountRef,
  type CloudAccounts,
  type ListCloudAccountsOptions,
} from "./types.js";
import {
  cloudAccountFromWire,
  createCloudAccountRequestToWire,
  updateCloudAccountRequestToWire,
} from "./wire.js";

export function createCloudAccounts(http: HTTPClient): CloudAccounts {
  const base = `${API_BASE_PATH}/cloud-accounts`;
  // `{ref}` takes `by`, and the server's default is ref, so a plain string
  // sends none. `provider` narrows a name to one provider's accounts.
  const path = (
    account: CloudAccountRef,
    options?: CloudAccountLookupOptions,
  ) => {
    const ref = normalizeRef(account, "cloud account");
    const params = new URLSearchParams();
    setRefSelector(params, "by", ref);
    if (options?.provider) params.set("provider", options.provider);
    return `${base}/${refPathSegment(ref)}${queryString(params)}`;
  };
  return {
    create: async (req) =>
      cloudAccountFromWire(
        (await http.doJSON<Record<string, unknown>>(
          "POST",
          base,
          createCloudAccountRequestToWire(req),
        )) ?? {},
      ),
    list: async (options?: ListCloudAccountsOptions) => {
      const params = new URLSearchParams();
      if (options?.provider) params.set("provider", options.provider);
      const envelope = await http.doJSON<{ items?: unknown[] }>(
        "GET",
        `${base}${queryString(params)}`,
      );
      return mapArray(envelope?.items, cloudAccountFromWire);
    },
    get: async (account, options) =>
      cloudAccountFromWire(
        (await http.doJSON<Record<string, unknown>>(
          "GET",
          path(account, options),
        )) ?? {},
      ),
    update: async (account, req, options) =>
      cloudAccountFromWire(
        (await http.doJSON<Record<string, unknown>>(
          "PATCH",
          path(account, options),
          updateCloudAccountRequestToWire(req),
        )) ?? {},
      ),
    delete: async (account, options) => {
      await http.doJSON("DELETE", path(account, options));
    },
  };
}

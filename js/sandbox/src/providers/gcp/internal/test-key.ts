/** A throwaway service account key for unit tests. */
import { generateKeyPairSync } from "node:crypto";

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
});

export const TEST_PUBLIC_KEY = publicKey;

export const TEST_KEY_JSON = {
  type: "service_account",
  project_id: "acme-proj",
  private_key_id: "kid1",
  private_key: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
  client_email: "amika@acme-proj.iam.gserviceaccount.com",
  // Ignored: tokens always come from Google's own endpoint.
  token_uri: "http://169.254.169.254/token",
};

export const TEST_CONFIG = {
  apiKey: JSON.stringify(TEST_KEY_JSON),
  apiUrl: "https://compute.test",
};

/** Start the host daemon's HTTP server. */
import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import {
  ConfigError,
  loadConfigFile,
  resolveConfig,
} from "./internal/config.js";

let config;
try {
  config = resolveConfig({
    env: process.env,
    file: loadConfigFile(process.env),
  });
} catch (error) {
  if (!(error instanceof ConfigError)) throw error;
  console.error(`amika-hostd: ${error.message}`);
  process.exit(1);
}

const app = createApp({
  apiUrl: config.smolApiUrl,
  requestTimeoutMs: config.smolRequestTimeoutMs,
});

const server = serve(
  { fetch: app.fetch, hostname: config.host, port: config.port },
  (info) => {
    console.log(`amika-hostd listening on http://${config.host}:${info.port}`);
  },
);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    server.close((error) => {
      if (error) {
        console.error(error);
        process.exitCode = 1;
      }
    });
  });
}

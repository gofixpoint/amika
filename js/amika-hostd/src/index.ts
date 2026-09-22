/** Start the host daemon's HTTP server. */
import { serve } from "@hono/node-server";
import { z } from "zod";
import { app } from "./app.js";

const env = z
  .object({
    HOST: z.string().min(1).default("127.0.0.1"),
    PORT: z.coerce.number().int().min(1).max(65535).default(3020),
  })
  .parse(process.env);

const server = serve(
  { fetch: app.fetch, hostname: env.HOST, port: env.PORT },
  (info) => {
    console.log(`amika-hostd listening on http://${env.HOST}:${info.port}`);
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

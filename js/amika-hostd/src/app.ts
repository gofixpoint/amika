/** HTTP surface for the local VM host daemon. */
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { SmolRuntime, type SmolRuntimeConfig } from "./internal/smol.js";
import {
  createMachineSchema,
  execSchema,
  filePath,
  machinePath,
} from "./internal/requests.js";

/** Build routes without opening a socket; the runtime transport is injectable. */
export function createApp(config: SmolRuntimeConfig = {}, fetcher = fetch) {
  const runtime = new SmolRuntime(config, fetcher);
  const app = new Hono();
  const machines = "/api/v1/machines";

  app.onError((error, c) => {
    if (error instanceof HTTPException) return error.getResponse();
    if (error instanceof z.ZodError || error instanceof SyntaxError) {
      return c.json({ error: "Invalid request" }, 400);
    }
    // Do not return commands, environment values, or upstream error bodies.
    return c.json({ error: "Internal server error" }, 500);
  });
  app.use(`${machines}/*`, bodyLimit({ maxSize: 64 * 1024 * 1024 }));
  app.get("/health", (c) => c.json({ status: "ok" }));
  app.get(machines, () => runtime.request(""));
  app.post(machines, async (c) =>
    runtime.request("", "POST", createMachineSchema.parse(await c.req.json())),
  );
  app.get(`${machines}/:name`, (c) =>
    runtime.request(machinePath(c.req.param("name"))),
  );
  app.delete(`${machines}/:name`, (c) =>
    runtime.request(machinePath(c.req.param("name")), "DELETE"),
  );
  for (const action of ["start", "stop"] as const) {
    app.post(`${machines}/:name/${action}`, (c) =>
      runtime.request(`${machinePath(c.req.param("name"))}/${action}`, "POST"),
    );
  }
  app.post(`${machines}/:name/exec`, async (c) =>
    runtime.request(
      `${machinePath(c.req.param("name"))}/exec`,
      "POST",
      execSchema.parse(await c.req.json()),
    ),
  );
  app.get(`${machines}/:name/files/*`, (c) =>
    runtime.request(filePath(c.req.param("name"), c.req.path)),
  );
  app.put(`${machines}/:name/files/*`, async (c) => {
    const path = filePath(c.req.param("name"), c.req.path);
    return runtime.request(
      path,
      "PUT",
      new Uint8Array(await c.req.arrayBuffer()),
    );
  });
  return app;
}

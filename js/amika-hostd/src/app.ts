/** HTTP surface for the local VM host daemon. */
import { Hono } from "hono";

export const app = new Hono();

app.get("/health", (c) => c.json({ status: "ok" }));

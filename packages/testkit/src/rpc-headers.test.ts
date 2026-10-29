import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { createApp } from "../../../apps/api/src/app.ts";

process.env.WAKEUP_DRIVER = "memory";
process.env.SANDBOX_PROVIDER = "fake";
process.env.AGENT_RUNTIME = "scripted";

const hasDb = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
const describeWithDatabase = hasDb ? describe : describe.skip;

let handles: Awaited<ReturnType<typeof createApp>> | undefined;
let dataDir: string | undefined;

describeWithDatabase("RPC reply headers", () => {
  beforeAll(async () => {
    const { createApp: build } = await import("../../../apps/api/src/app.ts");
    dataDir = mkdtempSync(path.join(tmpdir(), "rakazo-rpc-headers-"));
    handles = await build({ databaseUrl: process.env.DATABASE_URL!, dataDir });
  });

  afterAll(async () => {
    await handles?.stop();
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  });

  it("marks streaming RPC replies as not cacheable, including errors", async () => {
    if (!handles) throw new Error("app missing");
    const rpc = (path: string) =>
      handles.app.request(`/rpc/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ json: {} }),
      });
    const responses = {
      me: await rpc("me"),
      unknownProcedure: await rpc("not-a-procedure"),
    };
    expect(
      Object.fromEntries(
        Object.entries(responses).map(([name, response]) => [
          name,
          [response.status, response.headers.get("cache-control")],
        ]),
      ),
    ).toEqual({
      me: [200, "no-store"],
      unknownProcedure: [404, "no-store"],
    });
  });
});

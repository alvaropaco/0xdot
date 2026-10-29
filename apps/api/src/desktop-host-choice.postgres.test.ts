import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeSandboxProvider } from "@rakazo/adapters";
import { expect, it } from "vitest";
import { OWNER_COOKIE } from "../../../packages/testkit/src/index.js";
import { createApp } from "./app.js";

const databaseUrl = process.env.VERIFY_DATABASE === "1" ? process.env.DATABASE_URL : undefined;

it.skipIf(!databaseUrl).each([
  { sandboxProvider: "docker", nativeToken: true, expected: true },
  { sandboxProvider: "docker", nativeToken: false, expected: false },
  { sandboxProvider: "fake", nativeToken: true, expected: false },
])("exposes native host choice only on a managed Docker instance (%j)", async (fixture) => {
  const dataDir = await mkdtemp(join(tmpdir(), "rakazo-host-choice-"));
  const handles = await createApp({
    databaseUrl: databaseUrl!,
    dataDir,
    sandboxProvider: fixture.sandboxProvider,
    sandbox: new FakeSandboxProvider(),
    desktopStackToken: fixture.nativeToken ? "ab".repeat(32) : undefined,
    agentRuntime: "scripted",
    wakeupDriver: "memory",
    webOrigin: "http://127.0.0.1:5173",
  });
  try {
    const cookie = OWNER_COOKIE;
    for (const procedure of ["me", "bootstrap"]) {
      const response = await handles.app.request(`/rpc/${procedure}`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie, origin: "http://127.0.0.1:5173" },
        body: JSON.stringify({ json: {} }),
      });
      expect(response.status).toBe(200);
      const { json } = await response.json();
      expect(procedure === "me" ? json : json.me).toMatchObject({
        canChooseHostComputer: fixture.expected,
      });
    }
  } finally {
    await handles.stop();
    await rm(dataDir, { recursive: true, force: true });
  }
});

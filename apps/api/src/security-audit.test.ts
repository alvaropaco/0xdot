import { BotSecretPutInput } from "@rakazo/contracts";
import type * as Db from "@rakazo/db";
import { recordSecurityEvent } from "@rakazo/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { procedureSecurityEvent } from "./security-audit.js";

vi.mock("@rakazo/db", async (original) => ({
  ...(await original<typeof Db>()),
  recordSecurityEvent: vi.fn(async () => undefined),
}));

const actor = { userId: "user-1", spaceId: "space-1" };

beforeEach(() => vi.mocked(recordSecurityEvent).mockClear());

describe("procedureSecurityEvent", () => {
  it("records which credential changed without its value", () => {
    const event = procedureSecurityEvent(
      ["models", "connect"],
      { provider: "openrouter", apiKey: "sk-or-v1-secretvalue", label: "Work key" },
      actor,
    );
    expect(event).toEqual({
      type: "credential.created",
      userId: "user-1",
      spaceId: "space-1",
      metadata: { procedure: "models.connect", kind: "model", provider: "openrouter" },
    });
  });

  it("keeps secret names but never secret values", () => {
    const event = procedureSecurityEvent(
      ["botSecrets", "put"],
      // The real RPC shape, so a renamed field fails here instead of silently dropping the name.
      BotSecretPutInput.parse({
        botId: "bot-1",
        destination: { name: "github-deploy", auth: { type: "command" } },
        value: "ghp_secretvalue",
      }),
      actor,
    );
    expect(event?.metadata).toEqual({
      procedure: "botSecrets.put",
      kind: "bot_secret",
      botId: "bot-1",
      name: "github-deploy",
    });
    expect(JSON.stringify(event)).not.toContain("ghp_secretvalue");
  });

  it("records an MCP approval as a decision", () => {
    expect(
      procedureSecurityEvent(
        ["mcp", "assignments", "dismiss"],
        { botId: "bot-1", serverId: "server-1" },
        actor,
      ),
    ).toMatchObject({ type: "approval.decided", metadata: { decision: "deny", kind: "mcp" } });
  });

  it("ignores procedures that change nothing security-relevant", () => {
    expect(procedureSecurityEvent(["threads", "send"], { text: "hello" }, actor)).toBeUndefined();
  });
});

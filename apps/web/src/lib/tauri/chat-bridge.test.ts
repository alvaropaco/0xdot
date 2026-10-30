import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => undefined) }));

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { chat, onChatDone, onChatFailed } from "./chat-bridge";

const mockedInvoke = vi.mocked(invoke);
const mockedListen = vi.mocked(listen);

beforeEach(() => {
  mockedInvoke.mockReset();
  mockedListen.mockReset();
  mockedListen.mockResolvedValue(() => undefined);
});

describe("chat commands", () => {
  it("unwraps the ok result of a generated command", async () => {
    mockedInvoke.mockResolvedValue([{ id: "b1", name: "Chief" }]);
    await expect(chat.listBots()).resolves.toEqual([{ id: "b1", name: "Chief" }]);
    expect(mockedInvoke).toHaveBeenCalledWith("chat_bots_list");
  });

  it("rejects with the runtime error message", async () => {
    mockedInvoke.mockRejectedValue("no model connection configured");
    await expect(chat.send("t1", "hi")).rejects.toThrow("no model connection configured");
  });

  it("passes named arguments through to invoke", async () => {
    mockedInvoke.mockResolvedValue({ messageId: "m1" });
    await expect(chat.send("t1", "hello")).resolves.toEqual({ messageId: "m1" });
    expect(mockedInvoke).toHaveBeenCalledWith("chat_send", { threadId: "t1", content: "hello" });
  });

  it("sends the full settings payload", async () => {
    mockedInvoke.mockResolvedValue(null);
    await chat.setSettings("http://localhost:4000", "sk-test", "gpt-x");
    expect(mockedInvoke).toHaveBeenCalledWith("chat_settings_set", {
      baseUrl: "http://localhost:4000",
      apiKey: "sk-test",
      defaultModel: "gpt-x",
    });
  });
});

describe("chat events", () => {
  it("subscribes listeners to the typed topics and hands them the payload", async () => {
    const handler = vi.fn();
    const unlisten = await onChatDone(handler);
    expect(mockedListen).toHaveBeenCalledWith("chat://done", expect.any(Function));
    const callback = mockedListen.mock.calls[0]?.[1] as (event: { payload: unknown }) => void;
    callback({ payload: { threadId: "t1", messageId: "m2" } });
    expect(handler).toHaveBeenCalledWith({ threadId: "t1", messageId: "m2" });
    expect(typeof unlisten).toBe("function");
  });

  it("maps the error handler to chat://error", async () => {
    await onChatFailed(vi.fn());
    expect(mockedListen).toHaveBeenCalledWith("chat://error", expect.any(Function));
  });
});

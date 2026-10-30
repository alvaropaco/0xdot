// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatDeltaPayload, ChatDonePayload } from "../lib/tauri/chat-bridge";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const bridgeState = vi.hoisted(() => ({ sent: false, done: false }));

const deltaHandlers: Array<(payload: ChatDeltaPayload) => void> = [];
const doneHandlers: Array<(payload: ChatDonePayload) => void> = [];

vi.mock("../lib/tauri/chat-bridge", () => ({
  chat: {
    getSettings: vi.fn(async () => ({ baseUrl: "http://x", defaultModel: "m", hasApiKey: true })),
    setSettings: vi.fn(async () => undefined),
    listBots: vi.fn(async () => [
      { id: "b1", name: "Chief", systemPrompt: "", model: "", createdAt: "2026-01-01T00:00:00Z" },
    ]),
    createBot: vi.fn(),
    removeBot: vi.fn(),
    listThreads: vi.fn(async () => []),
    createThread: vi.fn(async () => ({
      id: "t1",
      botId: "b1",
      title: "",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    })),
    listMessages: vi.fn(async () => {
      const user = {
        id: "u1",
        threadId: "t1",
        role: "user",
        content: "hello",
        failed: false,
        createdAt: "2026-01-01T00:00:01Z",
      };
      if (!bridgeState.sent) return [];
      if (!bridgeState.done) return [user];
      return [
        user,
        {
          ...user,
          id: "a1",
          role: "assistant",
          content: "hi there",
          createdAt: "2026-01-01T00:00:02Z",
        },
      ];
    }),
    send: vi.fn(async () => {
      bridgeState.sent = true;
      return { messageId: "u1" };
    }),
  },
  onChatDelta: vi.fn(async (handler: (payload: ChatDeltaPayload) => void) => {
    deltaHandlers.push(handler);
    return () => undefined;
  }),
  onChatDone: vi.fn(async (handler: (payload: ChatDonePayload) => void) => {
    doneHandlers.push((payload) => {
      bridgeState.done = true;
      handler(payload);
    });
    return () => undefined;
  }),
  onChatFailed: vi.fn(async () => () => undefined),
}));

import { chat } from "../lib/tauri/chat-bridge";
import { LocalChat } from "./LocalChat";

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

async function flush(turns = 6) {
  for (let i = 0; i < turns; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

beforeEach(() => {
  bridgeState.sent = false;
  bridgeState.done = false;
  deltaHandlers.length = 0;
  doneHandlers.length = 0;
});

afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
});

async function renderChat() {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root.render(<LocalChat />));
  await flush();
}

describe("LocalChat", () => {
  it("loads the bot and opens a thread", async () => {
    await renderChat();
    expect(host.querySelector('[data-testid="local-chat"]')).toBeTruthy();
    expect(host.textContent).toContain("Chief");
    // No threads existed, so the runtime created one.
    expect(chat.createThread).toHaveBeenCalledWith("b1");
  });

  it("sends a message and streams the assistant reply", async () => {
    await renderChat();
    const composer = host.querySelector<HTMLInputElement>('[aria-label="Message"]');
    expect(composer).toBeTruthy();

    await act(async () => {
      const native = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value");
      native?.set?.call(composer, "hello");
      composer?.dispatchEvent(new Event("input", { bubbles: true }));
    });

    const sendButton = [...host.querySelectorAll("button")].find((b) => b.textContent === "Send");
    await act(async () => {
      sendButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();
    expect(chat.send).toHaveBeenCalledWith("t1", "hello");
    expect(host.querySelector('[data-testid="message-user"]')).toBeTruthy();

    // A delta from the runtime renders into the streaming bubble before done.
    await act(async () => {
      deltaHandlers.forEach((handler) => {
        handler({ threadId: "t1", text: "hi the" });
      });
    });
    const streaming = host.querySelector('[data-testid="message-streaming"]');
    expect(streaming?.textContent).toContain("hi the");

    // done persists the final message and re-lists the transcript.
    await act(async () => {
      doneHandlers.forEach((handler) => {
        handler({ threadId: "t1", messageId: "a1" });
      });
    });
    await flush();
    expect(host.querySelector('[data-testid="message-streaming"]')).toBeNull();
    expect(host.querySelector('[data-testid="message-assistant"]')?.textContent).toBe("hi there");
  });

  it("ignores events for other threads", async () => {
    await renderChat();
    await act(async () => {
      deltaHandlers.forEach((handler) => {
        handler({ threadId: "other", text: "nope" });
      });
    });
    expect(host.querySelector('[data-testid="message-streaming"]')).toBeNull();
  });
});

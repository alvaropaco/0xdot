// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ChatActivityHandler,
  ChatDeltaPayload,
  ChatDonePayload,
} from "../lib/tauri/chat-bridge";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const bridgeState = vi.hoisted(() => ({ sent: false, done: false }));

const deltaHandlers: Array<(payload: ChatDeltaPayload) => void> = [];
const doneHandlers: Array<(payload: ChatDonePayload) => void> = [];
const activityHandlers: ChatActivityHandler[] = [];

function chatMessage(
  overrides: Partial<{
    id: string;
    role: string;
    content: string;
    kind: string;
    payload: string;
    createdAt: string;
  }>,
) {
  return {
    id: overrides.id ?? "m",
    threadId: "t1",
    role: overrides.role ?? "assistant",
    content: overrides.content ?? "",
    failed: false,
    kind: overrides.kind ?? "chat",
    payload: overrides.payload ?? "",
    createdAt: "2026-01-01T00:00:00Z",
  };
}

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
      const user = chatMessage({
        id: "u1",
        role: "user",
        content: "hello",
        createdAt: "2026-01-01T00:00:01Z",
      });
      if (!bridgeState.sent) return [];
      if (!bridgeState.done) return [user];
      return [
        user,
        chatMessage({
          id: "a1",
          role: "assistant",
          content: "hi there",
          createdAt: "2026-01-01T00:00:02Z",
        }),
      ];
    }),
    send: vi.fn(async () => {
      bridgeState.sent = true;
      return { messageId: "u1" };
    }),
    decide: vi.fn(async () => true),
    screenshot: vi.fn(async () => ({ mime: "image/png", base64: "AAAA" })),
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
  onChatActivity: vi.fn(async (handler: ChatActivityHandler) => {
    activityHandlers.push(handler);
    return () => undefined;
  }),
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
  activityHandlers.length = 0;
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

function clickButton(label: string) {
  const button = [...host.querySelectorAll("button")].find((b) => b.textContent === label);
  act(() => button?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
}

describe("LocalChat", () => {
  it("loads the bot and opens a thread", async () => {
    await renderChat();
    expect(host.querySelector('[data-testid="local-chat"]')).toBeTruthy();
    expect(host.textContent).toContain("Chief");
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

    clickButton("Send");
    await flush();
    expect(chat.send).toHaveBeenCalledWith("t1", "hello");
    expect(host.querySelector('[data-testid="message-user"]')).toBeTruthy();

    await act(async () => {
      deltaHandlers.forEach((handler) => {
        handler({ threadId: "t1", text: "hi the" });
      });
    });
    expect(host.querySelector('[data-testid="message-streaming"]')?.textContent).toContain(
      "hi the",
    );

    await act(async () => {
      doneHandlers.forEach((handler) => {
        handler({ threadId: "t1", messageId: "a1" });
      });
    });
    await flush();
    expect(host.querySelector('[data-testid="message-streaming"]')).toBeNull();
    expect(host.querySelector('[data-testid="message-assistant"]')?.textContent).toBe("hi there");
  });

  it("renders tool activity rows pushed by the runtime", async () => {
    await renderChat();
    await act(async () => {
      activityHandlers.forEach((handler) => {
        handler(
          chatMessage({
            id: "ev1",
            kind: "tool",
            content: "Ran git.status",
            payload: '{"tool":"git.status","success":true}',
          }) as never,
        );
      });
    });
    const row = host.querySelector('[data-testid="activity-tool"]');
    expect(row?.textContent).toContain("Ran git.status");
  });

  it("shows an approval request and lets the user decide", async () => {
    await renderChat();
    const taskId = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
    await act(async () => {
      activityHandlers.forEach((handler) => {
        handler(
          chatMessage({
            id: "ap1",
            kind: "approval",
            content: "Approval requested: host.computer.run",
            payload: JSON.stringify({ status: "requested", taskId, tool: "host.computer.run" }),
          }) as never,
        );
      });
    });
    const approval = host.querySelector('[data-testid="activity-approval"]');
    expect(approval?.textContent).toContain("host.computer.run");
    expect(approval?.querySelector("button")).toBeTruthy();

    clickButton("Allow");
    expect(chat.decide).toHaveBeenCalledWith(taskId, true);
  });

  it("captures a screenshot preview on demand", async () => {
    await renderChat();
    clickButton("Capture");
    await flush();
    const img = host.querySelector<HTMLImageElement>('[data-testid="screenshot-preview"]');
    expect(img?.getAttribute("src")).toContain("data:image/png;base64,");
  });

  it("ignores delta events for other threads", async () => {
    await renderChat();
    await act(async () => {
      deltaHandlers.forEach((handler) => {
        handler({ threadId: "other", text: "nope" });
      });
    });
    expect(host.querySelector('[data-testid="message-streaming"]')).toBeNull();
  });
});

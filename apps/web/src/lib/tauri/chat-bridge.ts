/**
 * Thin adapter over the generated tauri-specta bindings (bindings.ts).
 * Components import `chat.*` from here instead of oRPC when the page runs on
 * the local Tauri runtime; `@tauri-apps/api` routes the calls through the
 * native IPC bridge.
 */

import { listen } from "@tauri-apps/api/event";
import { commands as chatCommands } from "./bindings";

export type { Bot, ChatMessage, ChatSettings, ChatThread, SendAccepted } from "./bindings";

/** Mirror of apps/desktop-tauri chat.rs; event payloads are not code-generated. */
export interface ChatDeltaPayload {
  threadId: string;
  text: string;
}

export interface ChatDonePayload {
  threadId: string;
  messageId: string;
}

export interface ChatFailedPayload {
  threadId: string;
  message: string;
}

type Result<T> = { status: "ok"; data: T } | { status: "error"; error: string };

async function unwrap<T>(promise: Promise<Result<T>>): Promise<T> {
  const result = await promise;
  if (result.status === "ok") return result.data;
  throw new Error(result.error);
}

export const chat = {
  getSettings: () => unwrap(chatCommands.chatSettingsGet()),
  setSettings: (baseUrl: string, apiKey: string, defaultModel: string) =>
    unwrap(chatCommands.chatSettingsSet(baseUrl, apiKey, defaultModel)),
  listBots: () => unwrap(chatCommands.chatBotsList()),
  createBot: (name: string, systemPrompt: string, model: string) =>
    unwrap(chatCommands.chatBotCreate(name, systemPrompt, model)),
  removeBot: (botId: string) => unwrap(chatCommands.chatBotRemove(botId)),
  listThreads: (botId: string) => unwrap(chatCommands.chatThreadsList(botId)),
  createThread: (botId: string) => unwrap(chatCommands.chatThreadCreate(botId)),
  listMessages: (threadId: string) => unwrap(chatCommands.chatMessagesList(threadId)),
  send: (threadId: string, content: string) => unwrap(chatCommands.chatSend(threadId, content)),
};

function on<T>(topic: string, handler: (payload: T) => void): Promise<() => void> {
  return listen(topic, (event) => handler(event.payload as T));
}

export const onChatDelta = (handler: (payload: ChatDeltaPayload) => void) =>
  on("chat://delta", handler);
export const onChatDone = (handler: (payload: ChatDonePayload) => void) =>
  on("chat://done", handler);
export const onChatFailed = (handler: (payload: ChatFailedPayload) => void) =>
  on("chat://error", handler);

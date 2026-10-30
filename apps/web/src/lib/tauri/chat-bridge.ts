/**
 * Thin adapter over the generated tauri-specta bindings (bindings.ts).
 * Components import `chat.*` from here instead of oRPC when the page runs on
 * the local Tauri runtime; `@tauri-apps/api` routes the calls through the
 * native IPC bridge.
 */

import { listen } from "@tauri-apps/api/event";
import type { ChatMessage } from "./bindings";
import { commands as chatCommands } from "./bindings";

export type {
  Bot,
  ChatMessage,
  ChatSettings,
  ChatThread,
  ScheduledRoutine,
  Screenshot,
  SearchHit,
  SendAccepted,
  UsageTotals,
} from "./bindings";

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
  decide: (taskId: string, approved: boolean) => unwrap(chatCommands.chatDecide(taskId, approved)),
  screenshot: () => unwrap(chatCommands.chatScreenshot()),
  search: (query: string, limit?: number) => unwrap(chatCommands.chatSearch(query, limit ?? null)),
  workspaceFiles: (botId: string) => unwrap(chatCommands.chatWorkspaceFiles(botId)),
  workspaceRead: (botId: string, path: string) =>
    unwrap(chatCommands.chatWorkspaceRead(botId, path)),
  listRoutines: () => unwrap(chatCommands.chatRoutinesList()),
  createRoutine: (
    botId: string,
    name: string,
    prompt: string,
    model: string,
    intervalSeconds: number,
  ) => unwrap(chatCommands.chatRoutineCreate(botId, name, prompt, model, intervalSeconds)),
  removeRoutine: (routineId: string) => unwrap(chatCommands.chatRoutineRemove(routineId)),
  setRoutineEnabled: (routineId: string, enabled: boolean) =>
    unwrap(chatCommands.chatRoutineSetEnabled(routineId, enabled)),
  usage: () => unwrap(chatCommands.chatUsage()),
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
/** A tool or approval timeline row emitted while the agent turn is running. */
export type ChatActivityHandler = (message: ChatMessage) => void;
export const onChatActivity = (handler: ChatActivityHandler) => on("chat://activity", handler);

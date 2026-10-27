import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export interface AgentExecutionRequest {
  model: string;
  prompt: string;
  systemPrompt?: string;
  temperature?: number;
  maxTokens?: number;
}
export interface AgentExecutionResponse {
  taskId: string;
  content: string;
  toolCalls: number;
  completed: boolean;
}
export interface AgentStartResponse {
  taskId: string;
}
export interface RuntimeEvent {
  type: string;
  data?: Record<string, unknown>;
}
export interface UpdateState {
  phase: string;
  currentVersion: string;
  availableVersion?: string;
  percent?: number;
  message?: string;
  checkedAt?: string;
}
export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}
export interface McpConnectRequest {
  id: string;
  config: McpServerConfig;
}
export interface McpTool {
  name: string;
  description?: string;
  inputSchema: unknown;
}

export const DESKTOP_EVENTS = {
  runtime: "rakazo://runtime-event",
  deepLink: "rakazo://deep-link",
} as const;
export function isTauriDesktop(): boolean {
  return typeof window !== "undefined" && Object.hasOwn(window, "__TAURI_INTERNALS__");
}

export const desktopApi = {
  window: {
    close: () => invoke("window_close"),
    minimize: () => invoke("window_minimize"),
    toggleMaximize: () => invoke("window_toggle_maximize"),
    state: () =>
      invoke<{ minimized: boolean; maximized: boolean; fullScreen: boolean }>("window_state"),
  },
  oauth: {
    open: (url: string) => invoke("oauth_open", { url }),
    cancel: (url: string) => invoke("oauth_cancel", { url }),
  },
  agent: {
    execute: (request: AgentExecutionRequest) =>
      invoke<AgentExecutionResponse>("agent_execute", { request }),
    start: (request: AgentExecutionRequest) =>
      invoke<AgentStartResponse>("agent_start", { request }),
    approve: (taskId: string, approved: boolean) =>
      invoke<boolean>("agent_approve", { taskId, approved }),
    pendingApprovals: () => invoke<string[]>("agent_pending_approvals"),
    state: () => invoke("agent_state"),
  },
  routines: {
    list: () => invoke("routine_list"),
    upsert: (routine: unknown) => invoke("routine_upsert", { routine }),
    remove: (routineId: string) => invoke<boolean>("routine_remove", { routineId }),
    tick: () => invoke("routine_tick"),
  },
  computer: {
    permissionState: () => invoke("computer_permission_state"),
    requestAccess: () => invoke<boolean>("computer_request_access"),
    revokeAccess: () => invoke("computer_revoke_access"),
    execute: (call: unknown) => invoke("computer_execute", { call }),
  },
  mcp: {
    connect: (request: McpConnectRequest) =>
      invoke<{ id: string; tools: McpTool[] }>("mcp_connect", { request }),
    listTools: (id: string) => invoke<McpTool[]>("mcp_list_tools", { id }),
    callTool: (id: string, name: string, arguments_: unknown) =>
      invoke("mcp_call_tool", { id, name, arguments: arguments_ }),
    disconnect: (id: string) => invoke<boolean>("mcp_disconnect", { id }),
  },
  updates: {
    state: () => invoke<UpdateState>("update_state"),
    check: () => invoke<UpdateState>("update_check"),
    download: () => invoke<UpdateState>("update_download"),
    install: () => invoke<UpdateState>("update_install"),
  },
};
export function onRuntimeEvent(handler: (event: RuntimeEvent) => void): Promise<UnlistenFn> {
  return listen<RuntimeEvent>(DESKTOP_EVENTS.runtime, ({ payload }) => handler(payload));
}
export function onDeepLink(handler: (urls: string[]) => void): Promise<UnlistenFn> {
  return listen<string[]>(DESKTOP_EVENTS.deepLink, ({ payload }) => handler(payload));
}

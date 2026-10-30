/**
 * Transport detection for the embedded Rust runtime. The packaged app serves
 * the UI from the Tauri asset origin (`tauri://localhost` /
 * `tauri.localhost`); `tauri dev` serves the same page from the Vite dev
 * server. Both mean "talk to the local runtime"; a page loaded from a remote
 * 0xdot server keeps using HTTP RPC as usual.
 */

export interface RuntimeHealth {
  mode: "local" | "remote";
  version: string;
  /** The external server in remote mode; null on the local runtime. */
  origin: string | null;
  /** False until the runtime exposes chat RPC (milestone M1). */
  rpcReady: boolean;
}

export function isTauriRuntimePage(): boolean {
  if (typeof window === "undefined" || !window.__TAURI__) return false;
  if (import.meta.env.DEV) return true;
  return window.location.hostname === "tauri.localhost" || window.location.protocol === "tauri:";
}

export async function fetchRuntimeHealth(): Promise<RuntimeHealth> {
  const tauri = window.__TAURI__;
  if (!tauri) throw new Error("Tauri runtime is not available");
  return tauri.core.invoke<RuntimeHealth>("runtime_health");
}

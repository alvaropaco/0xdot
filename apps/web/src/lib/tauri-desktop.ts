import type { RakazoDesktop, RakazoDesktopOAuthCallback, DesktopUpdateState } from "@rakazo/contracts";

interface TauriGlobal {
  core: {
    invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
  };
  event: {
    listen<T>(event: string, handler: (event: { payload: T }) => void): Promise<() => void>;
  };
}

declare global {
  interface Window {
    __TAURI__?: TauriGlobal;
  }
}

function tauri(): TauriGlobal | undefined {
  return typeof window === "undefined" ? undefined : window.__TAURI__;
}

async function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const api = tauri();
  if (!api) throw new Error("Tauri runtime is not available");
  return api.core.invoke<T>(command, args);
}

function unsupportedUpdateState(currentVersion = "0.0.0"): DesktopUpdateState {
  return {
    phase: "unsupported",
    currentVersion,
    availableVersion: null,
    percent: null,
    message: "Automatic updates are not configured for the Tauri build yet.",
    checkedAt: null,
  };
}

/** Installs the compatibility bridge consumed by the existing Rakazo web UI. */
export function installTauriDesktopBridge(): boolean {
  const api = tauri();
  if (!api || typeof window === "undefined") return false;
  if (window.rakazoDesktop) return true;

  const desktop: RakazoDesktop = {
    platform: navigator.platform.toLowerCase().includes("mac") ? "darwin" : navigator.platform.toLowerCase().includes("win") ? "win32" : "linux",
    window: {
      close: () => invoke("window_close"),
      minimize: () => invoke("window_minimize"),
      toggleMaximize: () => invoke("window_toggle_maximize"),
      state: () => invoke("window_state"),
    },
    update: {
      state: async () => {
        try {
          return await invoke<DesktopUpdateState>("update_state");
        } catch {
          return unsupportedUpdateState();
        }
      },
      check: async () => {
        try {
          return await invoke<DesktopUpdateState>("update_check");
        } catch {
          return unsupportedUpdateState();
        }
      },
      download: async () => {
        try {
          return await invoke<DesktopUpdateState>("update_download");
        } catch {
          return unsupportedUpdateState();
        }
      },
      install: async () => {
        try {
          return await invoke<DesktopUpdateState>("update_install");
        } catch {
          return unsupportedUpdateState();
        }
      },
    },
    oauth: {
      open: (authorizationUrl) => invoke("oauth_open", { url: authorizationUrl }),
      cancel: (authorizationUrl) => invoke("oauth_cancel", { url: authorizationUrl }),
      onCallback: (listener) => {
        let unsubscribe: (() => void) | undefined;
        void api.event
          .listen<RakazoDesktopOAuthCallback>("desktop://oauth-callback", (event) => listener(event.payload))
          .then((stop) => {
            unsubscribe = stop;
          });
        return () => unsubscribe?.();
      },
    },
    computer: {
      managesHostChoice: true,
      requestAccess: () => invoke<boolean>("computer_request_access"),
      revokeAccess: () => invoke("computer_revoke_access"),
      onConfigure: () => () => undefined,
    },
    badge: {
      set: (count) => invoke<boolean>("badge_set", { count }),
    },
  };

  window.rakazoDesktop = desktop;
  return true;
}

vi.mock("./ai-consent", () => ({ promptAiConsent: vi.fn() }));

import { isServerUnreachable, withLiveStreamingProgress } from "@rakazo/core";
import * as SecureStore from "expo-secure-store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promptAiConsent } from "./ai-consent";
import type { MobileMessage, MobileModelCredential, MobileSnapshot } from "./api.js";
import {
  adoptDeletedSpaceFallback,
  applyMobileThreadEvent,
  blockText,
  IDLE_TIMEOUT_MS,
  isServerReachable,
  loadApiBase,
  MAX_MOBILE_RPC_RESPONSE_BYTES,
  mergeMobileSnapshot,
  mobileThreadRefreshResult,
  prependMobileMessagePage,
  rpc,
  saveApiBase,
  selectedSpaceId,
  selectSpace,
  shouldApplyMobileThreadRefresh,
  spaceSelectionSeq,
  subscribeServerReachable,
  subscribeThread,
} from "./api.js";
import { resumeLiveNotifications } from "./live-notifications.js";
import { threadRefreshDelayMs } from "./refresh";

vi.mock("expo-secure-store", () => ({
  getItemAsync: vi.fn(),
  setItemAsync: vi.fn(),
  deleteItemAsync: vi.fn(),
}));
vi.mock("./live-notifications.js", () => ({
  resumeLiveNotifications: vi.fn(async () => undefined),
  stopLiveNotifications: vi.fn(async () => undefined),
}));
vi.mock("./network-cache.js", () => ({ clearNetworkCache: vi.fn() }));

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("mobile API requests", () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    vi.mocked(SecureStore.getItemAsync).mockReset();
    vi.mocked(SecureStore.setItemAsync).mockReset();
    vi.mocked(SecureStore.deleteItemAsync).mockReset();
    vi.mocked(resumeLiveNotifications).mockClear();
  });

  it("reports an rpc that hit its timeout as a timeout, not as a canceled fetch", async () => {
    vi.useFakeTimers();
    vi.mocked(SecureStore.getItemAsync).mockResolvedValue("session-token");
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_input: unknown, init?: { signal?: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () =>
              reject(new Error("fetch failed: FetchRequestCanceledException")),
            );
          }),
      ),
    );

    const pending = rpc("computer/status", { botId: "bot" });
    const rejection = expect(pending).rejects.toThrow("Request timed out");
    await vi.advanceTimersByTimeAsync(8_000);
    await rejection;
  });

  it("reports a stalled rpc response body as a timeout", async () => {
    vi.useFakeTimers();
    vi.mocked(SecureStore.getItemAsync).mockResolvedValue("session-token");
    const cancel = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(new ReadableStream({ cancel }))),
    );

    const pending = rpc("computer/status", { botId: "bot" });
    const rejection = expect(pending).rejects.toThrow("Request timed out");
    await vi.advanceTimersByTimeAsync(8_000);
    await rejection;
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("reports a caller's cancellation with the caller's reason", async () => {
    vi.useFakeTimers();
    vi.mocked(SecureStore.getItemAsync).mockResolvedValue("session-token");
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_input: unknown, init?: { signal?: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () =>
              reject(new Error("fetch failed: FetchRequestCanceledException")),
            );
          }),
      ),
    );

    const external = new AbortController();
    const pending = rpc("computer/status", { botId: "bot" }, { signal: external.signal });
    const rejection = expect(pending).rejects.toThrow("screen closed");
    await vi.advanceTimersByTimeAsync(0);
    external.abort(new Error("screen closed"));
    await rejection;
  });

  it("lets a call opt into a longer timeout", async () => {
    vi.useFakeTimers();
    vi.mocked(SecureStore.getItemAsync).mockResolvedValue("session-token");
    const fetchMock = vi.fn(
      (_input: unknown, init?: { signal?: AbortSignal }) =>
        new Promise<Response>((resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
          setTimeout(() => resolve(new Response(JSON.stringify({ json: { ok: true } }))), 20_000);
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const pending = rpc<{ ok: boolean }>("computer/boot", { botId: "bot" }, { timeoutMs: 120_000 });
    await vi.advanceTimersByTimeAsync(20_000);
    await expect(pending).resolves.toEqual({ ok: true });
  });

  it("publishes only reachability transitions and preserves transport causes", async () => {
    const changed = vi.fn();
    const unsubscribe = subscribeServerReachable(changed);
    vi.mocked(SecureStore.getItemAsync).mockResolvedValue("session-token");
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockRejectedValueOnce(new TypeError("Network request failed"))
        .mockResolvedValueOnce(rpcErrorResponse(404, "NOT_FOUND", "Bot does not exist")),
    );
    try {
      expect(isServerUnreachable(await rpc("bots/list").catch((error) => error))).toBe(true);
      expect(isServerReachable()).toBe(false);
      await expect(rpc("bots/get")).rejects.toThrow("Bot does not exist");
      expect(isServerReachable()).toBe(true);
      expect(changed).toHaveBeenCalledTimes(2);
    } finally {
      unsubscribe();
    }
  });

  it("counts an rpc timeout as unreachable and a reopened live connection as reachable again", async () => {
    vi.useFakeTimers();
    vi.mocked(SecureStore.getItemAsync).mockResolvedValue("session-token");
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_input: unknown, init?: { signal?: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () =>
              reject(new Error("fetch failed: FetchRequestCanceledException")),
            );
          }),
      ),
    );
    const pending = rpc("threads/get", { botId: "bot" }).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(8_000);
    expect(isServerUnreachable(await pending)).toBe(true);
    expect(isServerReachable()).toBe(false);

    const reachableAgain = vi.fn();
    const unsubscribe = subscribeServerReachable(reachableAgain);
    try {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response(new ReadableStream({ start: (c) => c.close() }))),
      );
      await subscribeThread({ botId: "bot" }, -1, vi.fn(), new AbortController().signal);
      expect(isServerReachable()).toBe(true);
      expect(reachableAgain).toHaveBeenCalledOnce();
    } finally {
      unsubscribe();
    }
  });

  it("shows the server's message instead of the procedure name", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => rpcErrorResponse(400, "BAD_REQUEST", "Connect a model to start a run.")),
    );

    await expect(rpc("bots/create", { name: "Ada" })).rejects.toThrow(
      new Error("Connect a model to start a run."),
    );
  });

  it.each([
    ["an empty", new Response(null, { status: 404 })],
    [
      "an HTML",
      new Response("<html>Bad Gateway</html>", {
        status: 502,
        headers: { "content-type": "text/html" },
      }),
    ],
  ])("reports a failure with %s body without a parser error", async (_body, response) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response),
    );

    await expect(rpc("bots/create", { name: "Ada" })).rejects.toThrow(
      new Error("Something went wrong. Try again."),
    );
  });

  it("sends model headers unchanged and reads names-only credential DTOs", async () => {
    const credential: MobileModelCredential = {
      id: "credential",
      provider: "openai-compatible",
      label: "Local",
      hasKey: false,
      isDefault: true,
      headerNames: ["x-session"],
    };
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () =>
      jsonResponse({ json: credential }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const input = {
      provider: "openai-compatible",
      baseUrl: "http://localhost:8000/v1",
      modelId: "custom",
      headers: { "x-session": "fake-session-secret" },
    };
    expect(await rpc<MobileModelCredential>("models/connect", input)).toEqual(credential);
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({ json: input });
    fetchMock.mockResolvedValueOnce(jsonResponse({ json: [credential] }));
    const listed = await rpc<MobileModelCredential[]>("models/credentials");
    expect(listed[0]?.headerNames).toEqual(["x-session"]);
    expect(JSON.stringify(listed)).not.toContain("fake-session-secret");
    await rpc("models/connect", { ...input, headers: undefined });
    expect(JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body)).json).not.toHaveProperty(
      "headers",
    );
    await rpc("models/connect", { ...input, headers: {} });
    expect(JSON.parse(String(fetchMock.mock.calls[3]?.[1]?.body)).json.headers).toEqual({});
    await rpc("models/probeOpenAiCompatible", {
      baseUrl: input.baseUrl,
      headers: input.headers,
      credentialId: credential.id,
    });
    expect(JSON.parse(String(fetchMock.mock.calls[4]?.[1]?.body)).json).toEqual({
      baseUrl: input.baseUrl,
      headers: input.headers,
      credentialId: credential.id,
    });
  });

  it("blocks mobile message and attachment submission when AI sharing is declined", async () => {
    vi.mocked(promptAiConsent).mockResolvedValue(false);
    const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      jsonResponse({
        json: {
          scope: "account-space",
          version: "2026-09-14",
          recipients: [
            { key: "provider", name: "Example AI", use: "model", detail: "", allowed: false },
          ],
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    for (const proc of ["threads/send", "artifacts/create", "routines/create"]) {
      await expect(rpc(proc, { botId: "bot-1", text: "private content" })).rejects.toThrow(
        "AI data sharing",
      );
    }
    expect(fetchMock).toHaveBeenCalledTimes(3);
    for (const [url, init] of fetchMock.mock.calls) {
      expect(String(url)).toContain("/rpc/aiConsent/status");
      expect(init?.body).not.toContain("private content");
    }
  });

  it.each([true, false])("explains the mobile upgrade requirement with JSON=%s", async (json) => {
    const fetchMock = vi.fn(async () =>
      json
        ? rpcErrorResponse(404, "NOT_FOUND", "Not found")
        : new Response("404 Not Found", { status: 404 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await expect(rpc("threads/send", { botId: "bot" })).rejects.toThrow("Update your server");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it.each(["throws", "rejects", "stalls"])(
    "reports the upgrade message when body cancellation %s",
    async (mode) => {
      const cancel = vi.fn(() => {
        if (mode === "throws") throw new Error("cancel failed");
        if (mode === "rejects") return Promise.reject(new Error("cancel failed"));
        return new Promise<void>(() => {});
      });
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => ({ status: 404, body: { cancel } })),
      );
      await expect(rpc("threads/send", { botId: "bot" })).rejects.toThrow("Update your server");
      expect(cancel).toHaveBeenCalledOnce();
    },
  );

  it("records mobile consent before submitting and uses the deployment policy URL", async () => {
    vi.mocked(promptAiConsent).mockResolvedValue(true);
    const calls: string[] = [];
    const recipient = {
      key: "provider",
      name: "Example AI",
      use: "model",
      detail: "",
      allowed: false,
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url) => {
        const path = new URL(String(url)).pathname;
        calls.push(path);
        return jsonResponse({
          json: path.endsWith("/status")
            ? {
                scope: "account-space",
                version: "2026-09-14",
                recipients: [recipient],
                privacyUrl: "https://example.com/privacy",
              }
            : { ok: true },
        });
      }),
    );
    await rpc("threads/send", { botId: "bot-1", text: "authorized content" });
    expect(calls).toEqual(["/rpc/aiConsent/status", "/rpc/aiConsent/allow", "/rpc/threads/send"]);
    expect(promptAiConsent).toHaveBeenLastCalledWith(recipient, "https://example.com/privacy");
  });

  it("coalesces concurrent mobile consent checks before sending each request once", async () => {
    vi.mocked(promptAiConsent).mockClear();
    vi.mocked(promptAiConsent).mockResolvedValue(true);
    const calls: string[] = [];
    const recipient = {
      key: "provider",
      name: "Example AI",
      use: "model",
      detail: "",
      allowed: false,
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url) => {
        const path = new URL(String(url)).pathname;
        calls.push(path);
        if (path.endsWith("/status"))
          return jsonResponse({
            json: {
              scope: "account-space",
              version: "2026-09-14",
              recipients: [recipient],
            },
          });
        return jsonResponse({ json: { ok: true } });
      }),
    );

    await Promise.all([
      rpc("threads/send", { botId: "bot-1", text: "first" }),
      rpc("threads/send", { botId: "bot-1", text: "second" }),
    ]);

    expect(promptAiConsent).toHaveBeenCalledTimes(1);
    expect(calls.filter((path) => path.endsWith("/aiConsent/status"))).toHaveLength(2);
    expect(calls.filter((path) => path.endsWith("/aiConsent/allow"))).toHaveLength(1);
    expect(calls.filter((path) => path.endsWith("/threads/send"))).toHaveLength(2);
  });

  it("coalesces a concurrent refusal without granting or replaying the action", async () => {
    vi.mocked(promptAiConsent).mockClear();
    vi.mocked(promptAiConsent).mockResolvedValue(false);
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url) => {
        const path = new URL(String(url)).pathname;
        calls.push(path);
        return jsonResponse({
          json: {
            scope: "account-space",
            version: "2026-09-14",
            recipients: [
              {
                key: "provider",
                name: "Example AI",
                use: "model",
                detail: "",
                allowed: false,
              },
            ],
          },
        });
      }),
    );

    const results = await Promise.allSettled([
      rpc("threads/send", { botId: "bot-1", text: "keep this draft" }),
      rpc("threads/send", { botId: "bot-1", text: "keep this draft" }),
    ]);

    expect(results.every((result) => result.status === "rejected")).toBe(true);
    expect(promptAiConsent).toHaveBeenCalledTimes(1);
    expect(calls.filter((path) => path.endsWith("/aiConsent/allow"))).toHaveLength(0);
    expect(calls.filter((path) => path.endsWith("/threads/send"))).toHaveLength(0);
  });

  it("rejects an oversized RPC response before parsing it", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(
          { json: { ok: true } },
          { headers: { "content-length": String(MAX_MOBILE_RPC_RESPONSE_BYTES + 1) } },
        ),
      ),
    );

    await expect(rpc("bots/get")).rejects.toThrow(new Error("Something went wrong. Try again."));
  });

  it("does not switch spaces when the selection cannot be persisted", async () => {
    await expect(selectSpace("space-support")).resolves.toBe(true);
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key) => {
      if (key === "rakazo.space_id") throw new Error("device locked");
    });

    await expect(selectSpace("space-social")).resolves.toBe(false);
    expect(selectedSpaceId()).toBe("space-support");

    vi.mocked(SecureStore.setItemAsync).mockReset();
    await selectSpace("");
  });

  it("does not switch spaces when stale recovery cannot be cleared", async () => {
    await selectSpace("space-support");
    vi.mocked(SecureStore.deleteItemAsync).mockImplementation(async (key) => {
      if (key === "rakazo.space_rollback") throw new Error("device locked");
    });
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      if (key === "rakazo.space_rollback" && value === "") throw new Error("device locked");
    });

    await expect(selectSpace("space-social")).resolves.toBe(false);
    expect(SecureStore.setItemAsync).not.toHaveBeenCalledWith("rakazo.space_id", "space-social");
    expect(selectedSpaceId()).toBe("space-support");

    vi.mocked(SecureStore.setItemAsync).mockReset();
    vi.mocked(SecureStore.deleteItemAsync).mockReset();
    await selectSpace("");
  });

  it("refuses to switch endpoints when SecureStore cannot clear credentials", async () => {
    await selectSpace("space-support");
    vi.mocked(SecureStore.deleteItemAsync).mockRejectedValue(new Error("device locked"));
    vi.mocked(SecureStore.setItemAsync).mockRejectedValue(new Error("device locked"));

    await expect(saveApiBase("https://second-server.example")).resolves.toEqual({
      ok: false,
      error: "Could not switch servers",
    });
    expect(SecureStore.setItemAsync).not.toHaveBeenCalledWith(
      "rakazo.api_base",
      "https://second-server.example",
    );
  });

  it("refuses an endpoint switch when the active space cannot be snapshotted", async () => {
    vi.mocked(SecureStore.getItemAsync).mockResolvedValue(null);
    await loadApiBase();
    vi.mocked(SecureStore.getItemAsync).mockImplementation(async (key) => {
      if (key === "rakazo.space_id") throw new Error("device locked");
      return null;
    });
    await loadApiBase();
    vi.mocked(SecureStore.deleteItemAsync).mockClear();

    await expect(saveApiBase("https://second-server.example")).resolves.toEqual({
      ok: false,
      error: "Could not switch servers",
    });
    expect(SecureStore.deleteItemAsync).not.toHaveBeenCalled();
  });

  it("recovers a deleted-space fallback over a stale saved selection after restart", async () => {
    const storage = new Map<string, string>([["rakazo.space_id", "space-deleted"]]);
    vi.mocked(SecureStore.getItemAsync).mockImplementation(async (key) => storage.get(key) ?? null);
    vi.mocked(SecureStore.deleteItemAsync).mockImplementation(async (key) => {
      storage.delete(key);
    });
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      if (key === "rakazo.space_id") throw new Error("device locked");
      storage.set(key, value);
    });
    await loadApiBase();

    await expect(selectSpace("space-personal")).resolves.toBe(false);
    await expect(adoptDeletedSpaceFallback("space-personal")).resolves.toBe(true);
    expect(selectedSpaceId()).toBe("space-personal");
    // Stale deleted id is cleared even while the replacement write stays locked.
    expect(storage.has("rakazo.space_id")).toBe(false);
    expect(storage.get("rakazo.space_rollback")).toBe(
      JSON.stringify({ apiBase: "http://127.0.0.1:3100", spaceId: "space-personal" }),
    );

    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      storage.set(key, value);
    });
    vi.resetModules();
    const restartedApi = await import("./api.js");
    await restartedApi.loadApiBase();
    expect(restartedApi.selectedSpaceId()).toBe("space-personal");
    expect(storage.get("rakazo.space_id")).toBe("space-personal");
    expect(storage.has("rakazo.space_rollback")).toBe(false);
  });

  it("clears a deleted selection when every SecureStore write fails after delete", async () => {
    const storage = new Map<string, string>([["rakazo.space_id", "space-deleted"]]);
    vi.mocked(SecureStore.getItemAsync).mockImplementation(async (key) => storage.get(key) ?? null);
    vi.mocked(SecureStore.deleteItemAsync).mockImplementation(async (key) => {
      storage.delete(key);
    });
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async () => {
      throw new Error("device locked");
    });
    await loadApiBase();

    await expect(selectSpace("space-personal")).resolves.toBe(false);
    await expect(adoptDeletedSpaceFallback("space-personal")).resolves.toBe(true);
    expect(selectedSpaceId()).toBe("space-personal");
    expect(storage.has("rakazo.space_id")).toBe(false);
    expect(storage.has("rakazo.space_rollback")).toBe(false);

    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      storage.set(key, value);
    });
    vi.resetModules();
    const restartedApi = await import("./api.js");
    await restartedApi.loadApiBase();
    // Cleared selection lets startup fall through to the server default.
    expect(restartedApi.selectedSpaceId()).toBeNull();
    await expect(restartedApi.selectInitialSpace("space-personal")).resolves.toBe(true);
    expect(restartedApi.selectedSpaceId()).toBe("space-personal");
    expect(storage.get("rakazo.space_id")).toBe("space-personal");
  });

  it("drops a stale deleted selection when rollback recovery cannot rewrite SPACE_KEY", async () => {
    const storage = new Map<string, string>([
      ["rakazo.space_id", "space-deleted"],
      [
        "rakazo.space_rollback",
        JSON.stringify({ apiBase: "http://127.0.0.1:3100", spaceId: "space-personal" }),
      ],
    ]);
    vi.mocked(SecureStore.getItemAsync).mockImplementation(async (key) => storage.get(key) ?? null);
    vi.mocked(SecureStore.deleteItemAsync).mockImplementation(async (key) => {
      storage.delete(key);
    });
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async () => {
      throw new Error("device locked");
    });
    vi.resetModules();
    const restartedApi = await import("./api.js");
    await restartedApi.loadApiBase();

    expect(restartedApi.selectedSpaceId()).toBe("space-personal");
    expect(storage.has("rakazo.space_id")).toBe(false);
    expect(storage.get("rakazo.space_rollback")).toBe(
      JSON.stringify({ apiBase: "http://127.0.0.1:3100", spaceId: "space-personal" }),
    );
  });

  it("does not let a stale rollback override a saved deleted-space fallback", async () => {
    const apiBase = "http://127.0.0.1:3100";
    const storage = new Map<string, string>([
      ["rakazo.space_id", "space-deleted"],
      ["rakazo.space_rollback", JSON.stringify({ apiBase, spaceId: "space-old" })],
    ]);
    vi.mocked(SecureStore.getItemAsync).mockImplementation(async (key) => storage.get(key) ?? null);
    vi.mocked(SecureStore.deleteItemAsync).mockImplementation(async (key) => {
      if (key === "rakazo.space_rollback") throw new Error("device locked");
      storage.delete(key);
    });
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      // clearStoredValue falls back to writing ""; keep that failing for rollback
      // so only an overwrite of the rollback payload can neutralize it.
      if (key === "rakazo.space_rollback" && value === "") throw new Error("device locked");
      storage.set(key, value);
    });
    await loadApiBase();

    await expect(adoptDeletedSpaceFallback("space-personal")).resolves.toBe(true);
    expect(selectedSpaceId()).toBe("space-personal");
    expect(storage.get("rakazo.space_id")).toBe("space-personal");
    // Neutralization overwrote the stale rollback; best-effort clear may leave
    // the matching recovery payload when delete/empty writes stay locked.
    expect(storage.get("rakazo.space_rollback")).toBe(
      JSON.stringify({ apiBase, spaceId: "space-personal" }),
    );

    vi.resetModules();
    const restartedApi = await import("./api.js");
    await restartedApi.loadApiBase();
    expect(restartedApi.selectedSpaceId()).toBe("space-personal");
    expect(storage.get("rakazo.space_id")).toBe("space-personal");
  });

  it("does not write SPACE_KEY beside a stale rollback when neutralization fails", async () => {
    const apiBase = "http://127.0.0.1:3100";
    const storage = new Map<string, string>([
      ["rakazo.space_id", "space-deleted"],
      ["rakazo.space_rollback", JSON.stringify({ apiBase, spaceId: "space-old" })],
    ]);
    vi.mocked(SecureStore.getItemAsync).mockImplementation(async (key) => storage.get(key) ?? null);
    vi.mocked(SecureStore.deleteItemAsync).mockImplementation(async () => {
      throw new Error("device locked");
    });
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      if (key === "rakazo.space_rollback") throw new Error("device locked");
      // Block recoverSpaceRollback during loadApiBase, and block SPACE_KEY clears.
      // Writes of the new fallback id would succeed — the bug was doing that write
      // before neutralization, then failing to undo it.
      if (key === "rakazo.space_id" && (value === "" || value === "space-old")) {
        throw new Error("device locked");
      }
      storage.set(key, value);
    });
    await loadApiBase();

    await expect(adoptDeletedSpaceFallback("space-personal")).resolves.toBe(false);
    expect(selectedSpaceId()).toBe("space-personal");
    // Must not leave the new selection durable beside the stale rollback.
    expect(storage.get("rakazo.space_id")).toBe("space-deleted");
    expect(storage.get("rakazo.space_rollback")).toBe(
      JSON.stringify({ apiBase, spaceId: "space-old" }),
    );

    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      if (key === "rakazo.space_rollback") throw new Error("device locked");
      storage.set(key, value);
    });
    vi.resetModules();
    const restartedApi = await import("./api.js");
    await restartedApi.loadApiBase();
    // Restart may still recover the old rollback target, but must not have
    // replaced a newer SPACE_KEY fallback with it.
    expect(restartedApi.selectedSpaceId()).toBe("space-old");
    expect(storage.get("rakazo.space_id")).toBe("space-old");
  });

  it("heals durable divergence when persisting a new Space fails", async () => {
    const storage = new Map<string, string>([["rakazo.space_id", "space-support"]]);
    vi.mocked(SecureStore.getItemAsync).mockImplementation(async (key) => storage.get(key) ?? null);
    vi.mocked(SecureStore.deleteItemAsync).mockImplementation(async (key) => {
      storage.delete(key);
    });
    await loadApiBase();
    await expect(selectSpace("space-support")).resolves.toBe(true);
    // A concurrent recovery persisted the claimed id, then the selection
    // write below fails and rolls the claim back.
    storage.set("rakazo.space_id", "space-new");
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      if (key === "rakazo.space_id" && value === "space-new") {
        throw new Error("device locked");
      }
      storage.set(key, value);
    });

    await expect(selectSpace("space-new")).resolves.toBe(false);
    expect(selectedSpaceId()).toBe("space-support");
    expect(storage.get("rakazo.space_id")).toBe("space-support");
  });

  it("keeps a newer overlapping selection when an older persist fails", async () => {
    const storage = new Map<string, string>([["rakazo.space_id", "space-support"]]);
    vi.mocked(SecureStore.getItemAsync).mockImplementation(async (key) => storage.get(key) ?? null);
    vi.mocked(SecureStore.deleteItemAsync).mockImplementation(async (key) => {
      storage.delete(key);
    });
    let rejectA!: (reason: Error) => void;
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      if (key === "rakazo.space_id" && value === "space-a") {
        await new Promise<never>((_, reject) => {
          rejectA = reject;
        });
      }
      storage.set(key, value);
    });
    await loadApiBase();

    const pendingA = selectSpace("space-a");
    await vi.waitFor(() => expect(selectedSpaceId()).toBe("space-a"));
    await expect(selectSpace("space-b")).resolves.toBe(true);
    rejectA(new Error("device locked"));

    await expect(pendingA).resolves.toBe(false);
    expect(selectedSpaceId()).toBe("space-b");
    expect(storage.get("rakazo.space_id")).toBe("space-b");
  });

  it("does not commit a selection superseded during rollback cleanup", async () => {
    const storage = new Map<string, string>([["rakazo.space_id", "space-current"]]);
    vi.mocked(SecureStore.getItemAsync).mockImplementation(async (key) => storage.get(key) ?? null);
    let releaseOlderCleanup!: () => void;
    let heldOlderCleanup = false;
    vi.mocked(SecureStore.deleteItemAsync).mockImplementation(async (key) => {
      if (key === "rakazo.space_rollback" && !heldOlderCleanup) {
        heldOlderCleanup = true;
        await new Promise<void>((resolve) => {
          releaseOlderCleanup = resolve;
        });
      }
      storage.delete(key);
    });
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      storage.set(key, value);
    });
    await loadApiBase();
    expect(selectedSpaceId()).toBe("space-current");

    const previousSeq = spaceSelectionSeq();
    const pendingOlder = selectSpace("space-older");
    expect(spaceSelectionSeq()).toBe(previousSeq + 1);
    expect(selectedSpaceId()).toBe("space-current");
    await vi.waitFor(() => expect(heldOlderCleanup).toBe(true));
    await expect(selectSpace("space-newer")).resolves.toBe(true);
    expect(spaceSelectionSeq()).toBe(previousSeq + 2);
    expect(selectedSpaceId()).toBe("space-newer");
    expect(storage.get("rakazo.space_id")).toBe("space-newer");

    releaseOlderCleanup();
    await expect(pendingOlder).resolves.toBe(false);
    expect(spaceSelectionSeq()).toBe(previousSeq + 2);
    expect(selectedSpaceId()).toBe("space-newer");
    expect(storage.get("rakazo.space_id")).toBe("space-newer");
  });

  it("converges durable state to the latest overlapping selection", async () => {
    const storage = new Map<string, string>([["rakazo.space_id", "space-support"]]);
    vi.mocked(SecureStore.getItemAsync).mockImplementation(async (key) => storage.get(key) ?? null);
    vi.mocked(SecureStore.deleteItemAsync).mockImplementation(async (key) => {
      storage.delete(key);
    });
    let resolveA!: () => void;
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      if (key === "rakazo.space_id" && value === "space-a") {
        await new Promise<void>((resolve) => {
          resolveA = resolve;
        });
      }
      storage.set(key, value);
    });
    await loadApiBase();

    const pendingA = selectSpace("space-a");
    await vi.waitFor(() => expect(selectedSpaceId()).toBe("space-a"));
    await expect(selectSpace("space-b")).resolves.toBe(true);
    // The older write lands stale after the newer one completed.
    resolveA();

    await expect(pendingA).resolves.toBe(true);
    expect(selectedSpaceId()).toBe("space-b");
    expect(storage.get("rakazo.space_id")).toBe("space-b");
  });

  it("keeps a later A claim when an earlier A→B→A persist fails", async () => {
    const storage = new Map<string, string>([["rakazo.space_id", "space-support"]]);
    vi.mocked(SecureStore.getItemAsync).mockImplementation(async (key) => storage.get(key) ?? null);
    vi.mocked(SecureStore.deleteItemAsync).mockImplementation(async (key) => {
      storage.delete(key);
    });
    let firstAWriteCount = 0;
    let rejectFirstA!: (reason: Error) => void;
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      if (key === "rakazo.space_id" && value === "space-a") {
        firstAWriteCount += 1;
        if (firstAWriteCount === 1) {
          await new Promise<never>((_, reject) => {
            rejectFirstA = reject;
          });
        }
      }
      storage.set(key, value);
    });
    await loadApiBase();

    const pendingFirstA = selectSpace("space-a");
    await vi.waitFor(() => expect(selectedSpaceId()).toBe("space-a"));
    await expect(selectSpace("space-b")).resolves.toBe(true);
    await expect(selectSpace("space-a")).resolves.toBe(true);
    expect(storage.get("rakazo.space_id")).toBe("space-a");
    rejectFirstA(new Error("device locked"));

    await expect(pendingFirstA).resolves.toBe(false);
    expect(selectedSpaceId()).toBe("space-a");
    expect(storage.get("rakazo.space_id")).toBe("space-a");
  });

  it("does not recover a space on a different endpoint", async () => {
    const storage = new Map([
      ["rakazo.api_base", "https://second-server.example"],
      [
        "rakazo.space_rollback",
        JSON.stringify({ apiBase: "http://127.0.0.1:3100", spaceId: "space-support" }),
      ],
    ]);
    vi.mocked(SecureStore.getItemAsync).mockImplementation(async (key) => storage.get(key) ?? null);
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      storage.set(key, value);
    });
    vi.mocked(SecureStore.deleteItemAsync).mockImplementation(async (key) => {
      storage.delete(key);
    });
    vi.resetModules();
    const restartedApi = await import("./api.js");

    await expect(restartedApi.loadApiBase()).resolves.toBe("https://second-server.example");
    expect(restartedApi.selectedSpaceId()).toBeNull();
    expect(storage.has("rakazo.space_rollback")).toBe(false);
  });

  it("removes a malformed space rollback record", async () => {
    const storage = new Map([["rakazo.space_rollback", "null"]]);
    vi.mocked(SecureStore.getItemAsync).mockImplementation(async (key) => storage.get(key) ?? null);
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      storage.set(key, value);
    });
    vi.mocked(SecureStore.deleteItemAsync).mockImplementation(async (key) => {
      storage.delete(key);
    });
    vi.resetModules();
    const restartedApi = await import("./api.js");

    await restartedApi.loadApiBase();
    expect(restartedApi.selectedSpaceId()).toBeNull();
    expect(storage.has("rakazo.space_rollback")).toBe(false);
  });
});

describe("mobile thread subscription", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.mocked(SecureStore.getItemAsync).mockReset();
    vi.mocked(SecureStore.getItemAsync).mockResolvedValue("");
  });

  it("parses fragmented SSE frames and ignores malformed data and completion markers", async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"json":{"type":"thread.pro'));
        controller.enqueue(
          encoder.encode(
            'gress","seq":4,"payload":{"delta":"Hi"}}}\n\ndata: not-json\n\ndata: [DONE]\n\n',
          ),
        );
        controller.enqueue(
          encoder.encode(
            'data: {"json":{"type":"thread.message.created",\n' +
              'data: "seq":5,"payload":{"messageId":"m1"}}}\n\n',
          ),
        );
        controller.close();
      },
    });
    const fetchMock = vi.fn(async () => new Response(stream, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const onEvent = vi.fn();

    await subscribeThread({ botId: "bot-1" }, 3, onEvent, new AbortController().signal);

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:3100/rpc/threads/subscribe",
      expect.objectContaining({
        headers: expect.objectContaining({ accept: "text/event-stream" }),
        body: JSON.stringify({ json: { botId: "bot-1", cursor: 3 } }),
      }),
    );
    expect(onEvent).toHaveBeenCalledTimes(2);
    expect(onEvent).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ type: "thread.progress", seq: 4 }),
    );
    expect(onEvent).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ type: "thread.message.created", seq: 5 }),
    );
  });

  it("rejects responses that are unsuccessful or have no stream body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 503 })),
    );
    await expect(
      subscribeThread({ botId: "bot-1" }, -1, vi.fn(), new AbortController().signal),
    ).rejects.toThrow("rpc threads/subscribe failed (503)");

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 200 })),
    );
    await expect(
      subscribeThread({ botId: "bot-1" }, -1, vi.fn(), new AbortController().signal),
    ).rejects.toThrow("rpc threads/subscribe failed (200)");
  });

  it("ignores heartbeat frames so the caller's cursor never skips an event", async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            'data: {"json":{"type":"heartbeat","seq":0,"payload":{}}}\n\n' +
              ": keepalive\n\n" +
              'data: {"json":{"type":"thread.progress","seq":1,"payload":{}}}\n\n',
          ),
        );
        controller.close();
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(stream, { status: 200 })),
    );
    const onEvent = vi.fn();

    await subscribeThread({ botId: "bot-1" }, -1, onEvent, new AbortController().signal);

    expect(onEvent).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ type: "thread.progress", seq: 1 }),
    );
  });

  it("gives up on a silent stream after the idle timeout so the caller reconnects", async () => {
    vi.useFakeTimers();
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start() {},
      cancel() {
        cancelled = true;
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(stream, { status: 200 })),
    );
    const onEvent = vi.fn();
    const abort = new AbortController();

    const running = subscribeThread({ botId: "bot-1" }, -1, onEvent, abort.signal);
    let settled = false;
    void running.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(IDLE_TIMEOUT_MS - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await running;

    expect(settled).toBe(true);
    expect(cancelled).toBe(true);
    expect(abort.signal.aborted).toBe(false);
    vi.useRealTimers();
  });
});

describe("mobile thread refresh targeting", () => {
  it("drops a deferred group A refresh after navigation to group B", async () => {
    let activeGroupId: string | undefined = "group-a";
    let currentEpoch = 1;
    let resolveRequest!: (snapshot: MobileSnapshot) => void;
    const request = new Promise<MobileSnapshot>((resolve) => {
      resolveRequest = resolve;
    });
    let applied: MobileSnapshot | null = null;
    const refresh = request.then((snapshot) => {
      if (
        shouldApplyMobileThreadRefresh({
          requestEpoch: 1,
          currentEpoch,
          targetBotId: undefined,
          targetGroupId: "group-a",
          activeBotId: undefined,
          activeGroupId,
        })
      ) {
        applied = snapshot;
      }
    });

    activeGroupId = "group-b";
    currentEpoch += 1;
    resolveRequest({
      groupId: "group-a",
      threadId: "thread-a",
      messages: [],
      olderCursor: null,
      run: null,
    });
    await refresh;

    expect(applied).toBeNull();
  });
});

describe("discarded mobile thread refresh cursor", () => {
  const onScreen = {
    ...snapshot([mobileMessage("shown", [{ kind: "text", text: "shown" }], 2)]),
    cursor: 2,
  };
  const fetched = {
    ...snapshot([
      mobileMessage("shown", [{ kind: "text", text: "shown" }], 2),
      mobileMessage("missed", [{ kind: "text", text: "from the discarded snapshot" }], 4),
      mobileMessage("also-missed", [{ kind: "text", text: "also only in that snapshot" }], 5),
    ]),
    cursor: 5,
  };
  const gate = {
    fetched,
    onScreen,
    requestEpoch: 1,
    currentEpoch: 1,
    requestGeneration: 1,
    currentGeneration: 1,
    targetBotId: "bot-1",
    targetGroupId: undefined,
    activeBotId: "bot-1",
    activeGroupId: undefined,
  };

  // The server replays events with seq greater than the subscription cursor.
  function shownAfter(cursor: number) {
    const events = [
      {
        type: "thread.message.created",
        seq: 4,
        payload: {
          messageId: "missed",
          role: "bot",
          blocks: [{ kind: "text", text: "from the discarded snapshot" }],
        },
      },
      {
        type: "thread.message.created",
        seq: 5,
        payload: {
          messageId: "also-missed",
          role: "bot",
          blocks: [{ kind: "text", text: "also only in that snapshot" }],
        },
      },
    ];
    return events.reduce<MobileSnapshot>(
      (view, event) => (event.seq > cursor ? (applyMobileThreadEvent(view, event) ?? view) : view),
      onScreen,
    );
  }

  it("shows events only a discarded refresh had seen when a newer refresh fails", () => {
    for (const discard of [{ currentGeneration: 2 }, { currentEpoch: 2 }]) {
      const result = mobileThreadRefreshResult({ ...gate, ...discard });
      const shown = shownAfter(result.snapshot?.cursor ?? -1);
      expect(result.commit).toBe(false);
      expect(shown.messages.map((message) => message.id)).toEqual([
        "shown",
        "missed",
        "also-missed",
      ]);
    }
  });

  it("keeps a live message applied while a refresh snapshot was in flight", () => {
    const live = applyMobileThreadEvent(fetched, {
      type: "thread.message.created",
      seq: 6,
      payload: {
        messageId: "new-live-message",
        role: "user",
        blocks: [{ kind: "text", text: "New message" }],
      },
    })!;
    const result = mobileThreadRefreshResult({ ...gate, onScreen: live });
    expect(result.commit).toBe(false);
    expect(result.snapshot).toBe(live);
    expect(result.snapshot?.messages.at(-1)?.id).toBe("new-live-message");
    expect(result.snapshot?.cursor).toBe(6);
    expect(mobileThreadRefreshResult({ ...gate, onScreen: fetched }).commit).toBe(true);
  });

  it("starts the subscription at a snapshot the refresh committed", () => {
    const result = mobileThreadRefreshResult(gate);
    expect(result.commit).toBe(true);
    expect(result.snapshot?.cursor).toBe(fetched.cursor);
  });
});

describe("mobile thread event reduction", () => {
  it("appends an emoji reply with its exact target", () => {
    const initial = snapshot([mobileMessage("message-1", [{ kind: "text", text: "Done" }])]);

    const next = applyMobileThreadEvent(initial, {
      type: "thread.message.created",
      seq: 4,
      payload: {
        messageId: "reaction-1",
        role: "user",
        blocks: [{ kind: "text", text: "❤️" }],
        replyToMessageId: "message-1",
      },
    });

    expect(next?.messages.find((message) => message.id === "reaction-1")).toMatchObject({
      role: "user",
      blocks: [{ kind: "text", text: "❤️" }],
      replyToMessageId: "message-1",
    });
    expect(next?.cursor).toBe(4);
  });

  it("appends a quoted reply carrying its excerpt", () => {
    const initial = snapshot([mobileMessage("message-1", [{ kind: "text", text: "Done" }])]);

    const next = applyMobileThreadEvent(initial, {
      type: "thread.message.created",
      seq: 4,
      createdAt: "2026-10-08T12:00:00.000Z",
      payload: {
        messageId: "reply-1",
        role: "user",
        blocks: [{ kind: "text", text: "why this?" }],
        replyToMessageId: "message-1",
        replyQuote: "Done",
        replyPreview: { role: "user", text: "Done" },
      },
    });

    expect(next?.messages.find((message) => message.id === "reply-1")).toMatchObject({
      role: "user",
      replyToMessageId: "message-1",
      replyQuote: "Done",
      replyPreview: { role: "user", text: "Done" },
      createdAt: "2026-10-08T12:00:00.000Z",
    });

    const updated = applyMobileThreadEvent(next, {
      type: "thread.message.updated",
      seq: 5,
      payload: { messageId: "reply-1", role: "user", blocks: [{ kind: "text", text: "Updated" }] },
    });
    expect(updated?.messages.find((message) => message.id === "reply-1")).toMatchObject({
      replyToMessageId: "message-1",
      replyQuote: "Done",
      replyPreview: { role: "user", text: "Done" },
      createdAt: "2026-10-08T12:00:00.000Z",
    });
  });

  it("keeps a message in its call when an update leaves the call id out", () => {
    const spoken: MobileMessage = {
      ...mobileMessage("message-1", [{ kind: "text", text: "Hi" }]),
      callId: "call-1",
    };
    const initial = snapshot([spoken]);

    const next = applyMobileThreadEvent(initial, {
      type: "thread.message.updated",
      seq: 5,
      payload: {
        messageId: "message-1",
        role: "bot",
        blocks: [{ kind: "text", text: "Hi. Talk soon." }],
      },
    });

    expect(next?.messages.find((message) => message.id === "message-1")).toMatchObject({
      callId: "call-1",
    });
  });

  it("prepends ordered history pages without duplicating the boundary message", () => {
    const initial = snapshot([mobileMessage("m-2", [], 2), mobileMessage("m-3", [], 3)], 2);

    const next = prependMobileMessagePage(initial, {
      threadId: "thread-1",
      messages: [
        mobileMessage("m-0", [], 0),
        mobileMessage("m-1", [], 1),
        mobileMessage("m-2", [], 2),
      ],
      olderCursor: null,
    });

    expect(next?.messages.map((item) => item.id)).toEqual(["m-0", "m-1", "m-2", "m-3"]);
    expect(next?.olderCursor).toBeNull();
  });

  it("retains loaded history across refresh while dropping stale progress", () => {
    const initial = snapshot(
      [
        mobileMessage("m-0", [], 0),
        mobileMessage("m-1", [], 1),
        mobileMessage("progress:run-1", [{ kind: "progress", text: "draft" }], 8),
      ],
      null,
    );
    const refreshed = snapshot([mobileMessage("m-1", [], 1), mobileMessage("m-2", [], 2)], 1);

    const next = mergeMobileSnapshot(initial, refreshed, true);

    expect(next.messages.map((item) => item.id)).toEqual(["m-0", "m-1", "m-2"]);
    expect(next.olderCursor).toBeNull();
  });

  it("accumulates progress deltas for the same run", () => {
    const first = applyMobileThreadEvent(snapshot(), {
      type: "thread.progress",
      runId: "run-1",
      payload: { delta: "Hel" },
    });
    const second = applyMobileThreadEvent(first, {
      type: "thread.progress",
      runId: "run-1",
      payload: { delta: "lo" },
    });

    expect(second?.messages).toEqual([
      {
        id: "progress:run-1",
        role: "bot",
        runId: "run-1",
        blocks: [{ kind: "progress", text: "Hello" }],
      },
    ]);
  });

  it("keeps hidden token progress so re-enabling streaming stays continuous", () => {
    const afterTokens = applyMobileThreadEvent(snapshot(), {
      type: "thread.progress",
      seq: 4,
      runId: "run-1",
      payload: { text: "Lis", streaming: true },
    });
    const afterDelta = applyMobileThreadEvent(afterTokens, {
      type: "thread.progress",
      seq: 5,
      runId: "run-1",
      payload: { delta: "bon", streaming: true },
    });

    expect(afterDelta?.cursor).toBe(5);
    expect(afterDelta?.messages).toEqual([
      {
        id: "progress:run-1",
        role: "bot",
        runId: "run-1",
        blocks: [{ kind: "progress", text: "Lisbon" }],
      },
    ]);
    expect(withLiveStreamingProgress(afterDelta, false)?.messages).toEqual([]);

    const afterComplete = applyMobileThreadEvent(afterDelta, {
      type: "thread.message.created",
      seq: 6,
      runId: "run-1",
      payload: {
        messageId: "m-final",
        role: "bot",
        blocks: [{ kind: "text", text: "Lisbon" }],
      },
    });
    expect(afterComplete?.messages).toEqual([
      expect.objectContaining({
        id: "m-final",
        blocks: [{ kind: "text", text: "Lisbon" }],
      }),
    ]);
  });

  it("resumes from retained tokens after streaming is turned back on mid-reply", () => {
    const afterPrefix = applyMobileThreadEvent(snapshot(), {
      type: "thread.progress",
      seq: 4,
      runId: "run-1",
      payload: { text: "Lis", streaming: true },
    });
    expect(withLiveStreamingProgress(afterPrefix, false)?.messages).toEqual([]);

    const afterResume = applyMobileThreadEvent(afterPrefix, {
      type: "thread.progress",
      seq: 5,
      runId: "run-1",
      payload: { delta: "bon", streaming: true },
    });
    expect(withLiveStreamingProgress(afterResume, true)?.messages).toEqual([
      {
        id: "progress:run-1",
        role: "bot",
        runId: "run-1",
        blocks: [{ kind: "progress", text: "Lisbon" }],
      },
    ]);
  });

  it("preserves progress from a legacy run-only snapshot", () => {
    const initial: MobileSnapshot = {
      ...snapshot([
        {
          ...mobileMessage("progress:run-legacy", [{ kind: "progress", text: "Still working" }]),
          runId: "run-legacy",
        },
      ]),
      run: { id: "run-legacy", status: "running" },
      activeRuns: undefined,
    };

    const next = applyMobileThreadEvent(initial, {
      type: "thread.progress",
      runId: "run-new",
      payload: { text: "New work" },
    });

    expect(next?.messages.map((item) => item.id)).toEqual([
      "progress:run-legacy",
      "progress:run-new",
    ]);
  });

  it("preserves concurrent progress when active-run metadata lags", () => {
    const initial: MobileSnapshot = {
      ...snapshot([
        {
          ...mobileMessage("progress:run-concurrent", [
            { kind: "progress", text: "Concurrent work" },
          ]),
          runId: "run-concurrent",
        },
      ]),
      run: { id: "run-current", status: "running" },
      activeRuns: [{ id: "run-current", status: "running" }],
    };

    const next = applyMobileThreadEvent(initial, {
      type: "thread.progress",
      runId: "run-current",
      payload: { text: "Current work" },
    });

    expect(next?.messages.map((item) => item.id)).toEqual([
      "progress:run-concurrent",
      "progress:run-current",
    ]);
  });

  it("holds live tool steps until mobile narration reaches a sentence boundary", () => {
    const narration = applyMobileThreadEvent(snapshot(), {
      type: "thread.progress",
      runId: "run-1",
      payload: { text: "Let me check " },
    });
    const pending = applyMobileThreadEvent(narration, {
      type: "agent.tool.called",
      runId: "run-1",
      payload: { name: "SLACK_FIND_CHANNELS" },
    });
    const completed = applyMobileThreadEvent(pending, {
      type: "thread.progress",
      runId: "run-1",
      payload: { delta: "now." },
    });

    expect(pending?.messages[0]?.blocks).toEqual([
      {
        kind: "progress",
        text: "Let me check ",
        pendingToolNames: ["SLACK_FIND_CHANNELS"],
      },
    ]);
    expect(completed?.messages[0]?.blocks).toEqual([
      { kind: "text", text: "Let me check now." },
      { kind: "steps", steps: [{ label: "Slack find channels", count: 1 }] },
    ]);
    expect(blockText(completed?.messages[0] as MobileMessage)).toBe(
      "Let me check now.\nSlack find channels",
    );
  });

  it("formats channel messages with their platform attribution", () => {
    expect(
      blockText(
        mobileMessage("channel-1", [
          {
            kind: "channel_message",
            provider: "sendblue",
            transport: "SMS",
            channelId: "ch-1",
            fromAddress: "+15551234567",
            fromLabel: "Alex",
            text: "Hello from the group",
          },
        ]),
      ),
    ).toBe("SMS · Alex: Hello from the group");
    expect(
      blockText(
        mobileMessage("channel-2", [
          {
            kind: "channel_message",
            provider: "slack",
            channelId: "ch-2",
            fromAddress: "U123456",
            fromLabel: "Alex",
            text: "Hello from the group",
          },
        ]),
      ),
    ).toBe("Slack · Alex: Hello from the group");
  });

  it("deduplicates durable messages and replaces matching transient subagent state", () => {
    const initial = snapshot([
      mobileMessage("message-1", [{ kind: "text", text: "old" }]),
      mobileMessage("subagent:research", [
        {
          kind: "subagent",
          agentId: "research",
          name: "Research",
          task: "Search",
          status: "running",
        },
      ]),
      mobileMessage("subagent:other", [
        { kind: "subagent", agentId: "other", name: "Other", task: "Wait", status: "running" },
      ]),
      {
        ...mobileMessage("progress:run-1", [{ kind: "progress", text: "draft" }]),
        runId: "run-1",
      },
    ]);
    const completed = {
      kind: "subagent" as const,
      agentId: "research",
      name: "Research",
      task: "Search",
      status: "completed" as const,
      result: "Done",
    };

    const next = applyMobileThreadEvent(initial, {
      id: "event-1",
      type: "thread.message.created",
      seq: 9,
      runId: "run-1",
      payload: { messageId: "message-1", role: "bot", blocks: [completed] },
    });

    expect(next?.messages.map((item) => item.id)).toEqual(["message-1", "subagent:other"]);
    expect(next?.messages[0]?.blocks).toEqual([completed]);
  });

  it("keeps a replayed bot-to-bot marker in its durable transcript position", () => {
    const peerBlock = {
      kind: "bot_message_received" as const,
      fromBotId: "bot-peer",
      fromBotName: "Peer",
      text: "Please check this.",
    };
    const initial = snapshot([
      mobileMessage("peer-message", [peerBlock], 1),
      mobileMessage("newer-message", [{ kind: "text", text: "Working on it." }], 2),
    ]);

    const next = applyMobileThreadEvent(initial, {
      type: "thread.message.created",
      seq: 9,
      payload: { messageId: "peer-message", role: "user", blocks: [peerBlock] },
    });

    expect(next?.messages.map((message) => message.id)).toEqual(["peer-message", "newer-message"]);
  });

  it("clears loaded history and active state when another client clears the thread", () => {
    const initial = snapshot([mobileMessage("message-1", [{ kind: "text", text: "old" }])], 1);
    initial.run = { id: "run-1", status: "running" };

    const next = applyMobileThreadEvent(initial, { type: "thread.cleared", seq: 12 });

    expect(next).toMatchObject({ cursor: 12, messages: [], olderCursor: null, run: null });
  });

  it("applies the durable waiting-input run transition", () => {
    const initial: MobileSnapshot = { ...snapshot(), run: { id: "run-1", status: "running" } };
    const waiting = applyMobileThreadEvent(initial, {
      type: "run.waiting_input",
      runId: "run-1",
      seq: 8,
    });

    expect(waiting?.run?.status).toBe("waiting_input");
    expect(waiting?.cursor).toBe(8);
    const repeated = applyMobileThreadEvent(waiting, {
      type: "run.waiting_input",
      runId: "run-1",
      seq: 9,
    });
    expect(repeated?.cursor).toBe(9);
    expect(repeated?.run).toBe(waiting?.run);
  });

  it("applies computer takeover requests as waiting_takeover", () => {
    const progress = mobileMessage("progress:run-1", [{ kind: "progress", text: "working…" }], 1);
    const initial: MobileSnapshot = {
      ...snapshot([progress]),
      run: { id: "run-1", status: "running" },
      activeRuns: [{ id: "run-1", status: "running" }],
    };
    const waiting = applyMobileThreadEvent(initial, {
      type: "computer.takeover.requested",
      runId: "run-1",
      seq: 10,
    });

    expect(waiting?.run?.status).toBe("waiting_takeover");
    expect(waiting?.activeRuns?.[0]?.status).toBe("waiting_takeover");
    expect(waiting?.messages.some((message) => message.id.startsWith("progress:"))).toBe(false);
    expect(waiting?.cursor).toBe(10);

    const released = applyMobileThreadEvent(
      {
        ...initial,
        run: { id: "run-1", status: "waiting_takeover" },
        activeRuns: [
          { id: "run-1", status: "waiting_takeover" },
          { id: "run-2", status: "waiting_takeover" },
        ],
      },
      {
        type: "computer.takeover.released",
        runId: "run-1",
        seq: 11,
      },
    );
    expect(released?.run?.status).toBe("queued");
    expect(released?.activeRuns).toEqual([
      { id: "run-1", status: "queued" },
      { id: "run-2", status: "waiting_takeover" },
    ]);
    expect(released?.cursor).toBe(11);

    const running = applyMobileThreadEvent(
      {
        ...snapshot(),
        run: { id: "run-1", status: "running" },
        activeRuns: [{ id: "run-1", status: "running" }],
      },
      { type: "computer.takeover.released", runId: "run-1", seq: 12 },
    );
    expect(running?.run?.status).toBe("running");
    expect(running?.activeRuns?.[0]?.status).toBe("running");
  });

  it("lets a newer refresh replace waiting_takeover with queued", () => {
    const waiting: MobileSnapshot = {
      ...snapshot(),
      cursor: 10,
      run: { id: "run-1", status: "waiting_takeover" },
      activeRuns: [{ id: "run-1", status: "waiting_takeover" }],
    };
    const refreshed: MobileSnapshot = {
      ...snapshot(),
      cursor: 12,
      run: { id: "run-1", status: "queued" },
      activeRuns: [{ id: "run-1", status: "queued" }],
    };

    const next = mergeMobileSnapshot(waiting, refreshed);

    expect(next.cursor).toBe(12);
    expect(next.run?.status).toBe("queued");
    expect(next.activeRuns?.[0]?.status).toBe("queued");
  });

  it("inserts a peer takeover run that was absent from the open snapshot", () => {
    const progress = mobileMessage(
      "progress:run-peer",
      [{ kind: "progress", text: "working…" }],
      1,
    );
    const initial: MobileSnapshot = {
      ...snapshot([progress]),
      run: { id: "run-user", status: "running" },
      activeRuns: [{ id: "run-user", status: "running" }],
      computer: {
        state: "running",
        controlHolder: "bot",
        screenAvailable: true,
        mode: "team",
        busyBotName: "Peer",
      },
    };

    const waiting = applyMobileThreadEvent(initial, {
      type: "computer.takeover.requested",
      runId: "run-peer",
      botId: "bot-peer",
      seq: 12,
    });

    expect(waiting?.run).toEqual({ id: "run-peer", botId: "bot-peer", status: "waiting_takeover" });
    expect(waiting?.activeRuns).toEqual([
      { id: "run-user", status: "running" },
      { id: "run-peer", botId: "bot-peer", status: "waiting_takeover" },
    ]);
    expect(waiting?.messages.some((message) => message.id.startsWith("progress:"))).toBe(false);
    expect(waiting?.computer?.busyBotName).toBeNull();
  });

  it("advances the cursor for durable message events", () => {
    const next = applyMobileThreadEvent(snapshot(), {
      type: "thread.message.created",
      seq: 11,
      payload: { messageId: "message-1", role: "bot", blocks: [{ kind: "text", text: "Done" }] },
    });

    expect(next?.cursor).toBe(11);
  });

  it("preserves ask actions and runId on created messages", () => {
    const initial = snapshot();
    const askBlock = {
      kind: "ask",
      text: "Review before writing",
      detail: "title: Result",
      status: "pending",
      actions: [
        { id: "allow", label: "Allow once" },
        { id: "always", label: "Always allow" },
        { id: "deny", label: "Deny" },
      ],
    };

    const next = applyMobileThreadEvent(initial, {
      type: "thread.message.created",
      runId: "run-1",
      payload: { messageId: "message-ask", role: "bot", blocks: [askBlock] },
    });

    expect(next?.messages.at(-1)).toMatchObject({
      id: "message-ask",
      runId: "run-1",
      blocks: [askBlock],
    });
  });

  it("updates a waiting group run without replacing the newer active run", () => {
    const initial: MobileSnapshot = {
      ...snapshot(),
      run: { id: "run-newer", status: "running" },
      activeRuns: [
        { id: "run-newer", status: "running" },
        { id: "run-waiting", status: "running" },
      ],
    };

    const waiting = applyMobileThreadEvent(initial, {
      type: "run.waiting_input",
      runId: "run-waiting",
    });

    expect(waiting?.run).toEqual({ id: "run-newer", status: "running" });
    expect(waiting?.activeRuns).toEqual([
      { id: "run-newer", status: "running" },
      { id: "run-waiting", status: "waiting_input" },
    ]);
  });

  it("clears only the terminal run's live progress", () => {
    const runA = { id: "run-a", status: "running" };
    const runB = { id: "run-b", status: "running" };
    const initial: MobileSnapshot = {
      ...snapshot([
        {
          ...mobileMessage("progress:run-a", [{ kind: "progress", text: "A" }]),
          runId: runA.id,
        },
        {
          ...mobileMessage("progress:run-b", [{ kind: "progress", text: "B" }]),
          runId: runB.id,
        },
      ]),
      run: runA,
      activeRuns: [runA, runB],
    };

    const next = applyMobileThreadEvent(initial, {
      type: "run.cancelled",
      seq: 10,
      runId: runA.id,
    });

    expect(next?.messages.map((item) => item.id)).toEqual(["progress:run-b"]);
    expect(next?.run).toEqual(runB);
    expect(next?.activeRuns).toEqual([runB]);
    expect(next?.cursor).toBe(10);
  });

  it("keeps a failed member run's error while another member run is still active", () => {
    const runA = { id: "run-a", status: "running" };
    const runB = { id: "run-b", status: "running" };
    const initial: MobileSnapshot = {
      ...snapshot([
        {
          ...mobileMessage("progress:run-b", [{ kind: "progress", text: "B" }]),
          runId: runB.id,
        },
      ]),
      run: runA,
      activeRuns: [runA, runB],
    };

    const next = applyMobileThreadEvent(initial, {
      type: "run.failed",
      seq: 11,
      runId: runB.id,
      payload: { error: "member exploded" },
    });

    expect(next?.activeRuns).toEqual([runA]);
    expect(next?.run).toEqual({ id: runB.id, status: "failed", error: "member exploded" });
    expect(next?.messages).toEqual([]);
  });

  it("updates a cloud agent card from thread.cloud_agent", () => {
    const initial = snapshot([
      mobileMessage("msg-ca", [
        {
          kind: "cloud_agent",
          agentId: "ca-1",
          title: "Add README",
          status: "running",
          url: "https://example.test/agents/ca-1",
        },
      ]),
    ]);

    const next = applyMobileThreadEvent(initial, {
      type: "thread.cloud_agent",
      seq: 9,
      payload: {
        messageId: "msg-ca",
        agentId: "ca-1",
        title: "Add README",
        status: "finished",
        url: "https://example.test/agents/ca-1",
        branch: "cursor/add-readme",
        prUrl: "https://github.com/example/repo/pull/1",
      },
    });

    expect(next?.cursor).toBe(9);
    expect(next?.messages[0]?.blocks[0]).toEqual({
      kind: "cloud_agent",
      agentId: "ca-1",
      title: "Add README",
      status: "finished",
      url: "https://example.test/agents/ca-1",
      branch: "cursor/add-readme",
      prUrl: "https://github.com/example/repo/pull/1",
    });
  });

  it("starts an idle run from live events and selects the active safety cadence", () => {
    const initial: MobileSnapshot = { ...snapshot(), run: null, activeRuns: [] };
    expect(threadRefreshDelayMs(initial.run?.status, { liveSubscribed: true })).toBe(60_000);
    const started = applyMobileThreadEvent(initial, {
      type: "run.started",
      runId: "run-remote",
      botId: "bot-1",
      seq: 12,
      payload: { trigger: "routine" },
    });
    expect(started?.cursor).toBe(12);
    expect(started?.run).toEqual({
      id: "run-remote",
      botId: "bot-1",
      status: "running",
      error: null,
    });
    expect(started?.activeRuns).toEqual([started?.run]);
    expect(threadRefreshDelayMs(started?.run?.status, { liveSubscribed: true })).toBe(30_000);
    const finished = applyMobileThreadEvent(started, {
      type: "run.completed",
      runId: "run-remote",
      seq: 13,
    });
    expect(finished?.run).toBeNull();
    expect(finished?.activeRuns).toEqual([]);
  });

  it("resumes a waiting run without duplicating it or dropping other paused runs", () => {
    const initial: MobileSnapshot = {
      ...snapshot(),
      run: { id: "run-1", status: "waiting_input" },
      activeRuns: [
        { id: "run-1", status: "waiting_input" },
        { id: "run-2", status: "waiting_takeover" },
        { id: "run-old", status: "completed" },
      ],
    };
    const next = applyMobileThreadEvent(initial, { type: "run.started", runId: "run-1" });
    expect(next?.run?.status).toBe("running");
    expect(next?.activeRuns).toEqual([
      { id: "run-2", status: "waiting_takeover" },
      { id: "run-1", status: "running", error: null },
    ]);
  });

  it("ignores background run starts and preserves group failures on member starts", () => {
    const initial: MobileSnapshot = {
      ...snapshot(),
      groupId: "group-1",
      run: { id: "run-failed", status: "failed", error: "Failed" },
      activeRuns: [],
    };
    expect(
      applyMobileThreadEvent(initial, {
        type: "run.started",
        runId: "run-background",
        payload: { trigger: "tickets" },
      }),
    ).toBe(initial);
    const next = applyMobileThreadEvent(initial, { type: "run.started", runId: "run-new" });
    expect(next?.run).toBe(initial.run);
    expect(next?.activeRuns).toEqual([{ id: "run-new", status: "running", error: null }]);
  });

  it("leaves the snapshot unchanged for unrelated events", () => {
    const initial = snapshot();
    expect(applyMobileThreadEvent(initial, { type: "run.checkpointed" })).toBe(initial);
    expect(applyMobileThreadEvent(null, { type: "thread.progress" })).toBeNull();
  });
});

function jsonResponse(body: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    ...init,
  });
}

/** A failed procedure as the oRPC server sends it. */
function rpcErrorResponse(status: number, code: string, message: string) {
  return jsonResponse({ json: { defined: false, code, status, message } }, { status });
}

function snapshot(
  messages: MobileMessage[] = [],
  olderCursor: number | null = null,
): MobileSnapshot {
  return {
    botId: "bot-1",
    threadId: "thread-1",
    cursor: 3,
    messages,
    olderCursor,
    run: null,
    computer: {
      state: "running",
      controlHolder: "bot",
      screenAvailable: true,
      mode: "team",
      busyBotName: null,
    },
  };
}

function mobileMessage(id: string, blocks: MobileMessage["blocks"], seq?: number): MobileMessage {
  return { id, threadId: "thread-1", seq, role: "bot", blocks };
}

describe("mobile clipboard text", () => {
  it("copies message content with transport labels and omits card chrome", async () => {
    const { copyableMobileMessageText } = await import("./api");
    expect(
      copyableMobileMessageText({
        id: "message",
        role: "bot",
        blocks: [
          { kind: "text", text: "Hello" },
          {
            kind: "channel_message",
            provider: "sendblue",
            transport: "SMS",
            channelId: "ch-1",
            fromAddress: "+15551234567",
            fromLabel: "Sender",
            text: "Reply",
          },
          { kind: "card", lines: [] },
        ],
      }),
    ).toBe("Hello\nSMS · Sender: Reply");
  });

  it("keeps leading whitespace for selection while copying trims it", async () => {
    const { copyableMobileMessageText, selectableMobileMessageText } = await import("./api");
    const message: MobileMessage = {
      id: "message",
      role: "user",
      blocks: [{ kind: "text", text: "    indented\nnext  " }],
    };
    expect(selectableMobileMessageText(message)).toBe("    indented\nnext  ");
    expect(copyableMobileMessageText(message)).toBe("indented\nnext");
  });
});

it("keeps the thread id on live messages so inline cards can act on them", () => {
  const view = applyMobileThreadEvent(
    { threadId: "chat", messages: [], olderCursor: null, run: null } as MobileSnapshot,
    {
      type: "thread.message.created",
      seq: 1,
      payload: { messageId: "card", role: "bot", blocks: [] },
    } as never,
  );
  expect(view?.messages[0]?.threadId).toBe("chat");
});

describe("stale helper projection", () => {
  it.each([
    "run.waiting_input",
    "computer.takeover.requested",
    "run.completed",
    "run.failed",
    "run.cancelled",
  ])("settles helpers on %s without reviving them on resume", (type) => {
    const base = {
      id: "fixture",
      threadId: "thread-1",
      runId: "run-1",
      seq: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    const helper = { agentId: "helper", name: "Helper", task: "Check", status: "running" };
    let next = applyMobileThreadEvent(snapshot(), {
      ...base,
      type: "thread.subagent",
      payload: helper,
    });
    next = applyMobileThreadEvent(next, { ...base, seq: 2, type, payload: {} });
    expect(next?.messages.find((m) => m.id === "subagent:helper")?.blocks[0]).toMatchObject({
      status: "failed",
      result: "stopped",
    });
    next = applyMobileThreadEvent(next, { ...base, seq: 3, type: "run.started", payload: {} });
    next = applyMobileThreadEvent(next, {
      ...base,
      seq: 4,
      type: "thread.subagent",
      payload: { ...helper, agentId: "resumed" },
    });
    expect(next?.messages.find((m) => m.id === "subagent:helper")?.blocks[0]).toMatchObject({
      status: "failed",
    });
    expect(next?.messages.find((m) => m.id === "subagent:resumed")?.blocks[0]).toMatchObject({
      status: "running",
    });
  });
});

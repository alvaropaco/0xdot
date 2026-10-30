// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchRuntimeHealth, isTauriRuntimePage, type RuntimeHealth } from "./tauri-runtime";

afterEach(() => {
  vi.unstubAllGlobals();
  delete window.__TAURI__;
});

function stubTauri(invoke = vi.fn()) {
  window.__TAURI__ = {
    core: { invoke },
    event: { listen: vi.fn(async () => () => undefined) },
  };
  return invoke;
}

describe("isTauriRuntimePage", () => {
  it("is false without the Tauri global", () => {
    expect(isTauriRuntimePage()).toBe(false);
  });

  it("is true with the Tauri global under dev (tauri dev serves the Vite page)", () => {
    stubTauri();
    // Vitest runs with import.meta.env.DEV, which is what `tauri dev` sees too.
    expect(isTauriRuntimePage()).toBe(true);
  });
});

describe("fetchRuntimeHealth", () => {
  it("invokes runtime_health and passes the payload through", async () => {
    const health: RuntimeHealth = {
      mode: "local",
      version: "0.1.0-test",
      origin: null,
      rpcReady: false,
    };
    const invoke = stubTauri(vi.fn(async () => health));
    await expect(fetchRuntimeHealth()).resolves.toEqual(health);
    expect(invoke).toHaveBeenCalledWith("runtime_health");
  });

  it("rejects without the Tauri global", async () => {
    await expect(fetchRuntimeHealth()).rejects.toThrow(/not available/);
  });
});

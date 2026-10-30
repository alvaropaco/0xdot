// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RuntimeHealth } from "../lib/tauri-runtime";
import { LocalRuntimeGate } from "./LocalRuntimeGate";

function stubInvoke(impl: (command: string) => Promise<unknown>) {
  window.__TAURI__ = {
    core: { invoke: vi.fn((command: string) => impl(command)) },
    event: { listen: vi.fn(async () => () => undefined) },
    // The global's invoke is generic; the stub satisfies it at runtime.
  } as unknown as typeof window.__TAURI__;
}

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

function renderGate() {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root.render(<LocalRuntimeGate />));
}

afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
  delete window.__TAURI__;
});

describe("LocalRuntimeGate", () => {
  it("shows mode, version and health once the runtime answers", async () => {
    stubInvoke(
      async (): Promise<RuntimeHealth> => ({
        mode: "local",
        version: "0.1.0-test",
        origin: null,
        rpcReady: false,
      }),
    );
    renderGate();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    const status = host.querySelector<HTMLElement>('[data-testid="runtime-status"]');
    expect(status?.textContent).toBe("Runtime: local · v0.1.0-test");
    expect(host.textContent).toContain("Health: online");
    expect(host.textContent).toContain("native chat");
  });

  it("surfaces an unreachable runtime", async () => {
    stubInvoke(async () => {
      throw new Error("no runtime");
    });
    renderGate();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(host.textContent).toContain("runtime unreachable");
  });
});

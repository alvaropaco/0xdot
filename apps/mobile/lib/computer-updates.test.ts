import { afterEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock("./api", () => ({ rpc: api.rpc }));

import { computerUpdates } from "./computer-updates";

afterEach(() => {
  vi.useRealTimers();
  api.rpc.mockReset();
});

describe("mobile computer updates", () => {
  it("lists updates through the mobile rpc and keeps polling after a failure", async () => {
    vi.useFakeTimers();
    api.rpc.mockRejectedValueOnce(new Error("offline"));
    api.rpc.mockResolvedValue([]);
    const stop = computerUpdates.watch();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(api.rpc).toHaveBeenCalledWith("computer/updates");
    expect(api.rpc.mock.calls.length).toBeGreaterThan(1);
    stop();
  });
});

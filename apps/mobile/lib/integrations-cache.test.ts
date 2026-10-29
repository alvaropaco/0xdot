import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IntegrationsCacheScope } from "./integrations-cache";
import {
  integrationsCacheScope,
  isIntegrationsScopeCurrent,
  persistedIntegrationsCacheScope,
  readIntegrationsCache,
  writeIntegrationsCache,
} from "./integrations-cache";

const state = vi.hoisted(() => ({
  files: new Map<string, string>(),
  base: "https://api.example.test",
  space: "space-a",
  rpc: vi.fn(),
  broken: false,
  secure: new Map<string, string>(),
  getItemAsync: vi.fn(),
  setItemAsync: vi.fn(),
}));
vi.mock("./api", () => ({
  currentApiBase: () => state.base,
  selectedSpaceId: () => state.space,
  rpc: state.rpc,
}));
vi.mock("expo-secure-store", () => ({
  getItemAsync: state.getItemAsync,
  setItemAsync: state.setItemAsync,
  deleteItemAsync: vi.fn(),
}));
vi.mock("expo-file-system", () => {
  class Directory {
    uri: string;
    get exists() {
      return true;
    }
    constructor(...parts: Array<string | { uri: string }>) {
      this.uri = parts.map((part) => (typeof part === "string" ? part : part.uri)).join("/");
    }
    create() {}
  }
  class File extends Directory {
    override get exists() {
      return state.files.has(this.uri);
    }
    override create() {
      if (state.broken) throw new Error("disk unavailable");
    }
    textSync() {
      return state.files.get(this.uri);
    }
    write(value: string) {
      state.files.set(this.uri, value);
    }
  }
  return { Directory, File, Paths: { cache: "cache" } };
});
const scope: IntegrationsCacheScope = {
  apiBase: "https://api.example.test",
  userId: "user-a",
  spaceId: "space-a",
  selectionId: "space-a",
};
const snapshot = {
  catalog: [
    {
      connectorId: "test",
      slug: "example",
      name: "Example",
      logo: "https://example.test/logo.svg",
      connected: true,
      noAuth: false,
    },
  ],
  connections: [
    {
      id: "connection-a",
      connectorId: "test",
      provider: "example",
      displayName: "Example",
      status: "connected" as const,
      capabilities: [],
      createdAt: "2026-01-01",
    },
  ],
};

beforeEach(() => {
  state.files.clear();
  state.base = scope.apiBase;
  state.space = scope.spaceId;
  state.broken = false;
  state.secure.clear();
  state.getItemAsync
    .mockReset()
    .mockImplementation(async (key: string) => state.secure.get(key) ?? null);
  state.setItemAsync.mockReset().mockImplementation(async (key: string, value: string) => {
    state.secure.set(key, value);
  });
  state.rpc.mockReset().mockResolvedValue({ userId: "user-a", spaceId: "space-a" });
});

describe("integration disk cache", () => {
  it("round trips catalog artwork and Added accounts, including local mutations", () => {
    expect(readIntegrationsCache(scope)).toBeNull();
    writeIntegrationsCache(scope, snapshot);
    expect(readIntegrationsCache(scope)).toEqual(snapshot);
    const next = {
      ...snapshot,
      connections: [
        { ...snapshot.connections[0]!, displayName: "Renamed", status: "revoked" as const },
      ],
    };
    writeIntegrationsCache(scope, next);
    expect(readIntegrationsCache(scope)).toEqual(next);
  });
  it.each([
    { userId: "user-b" },
    { spaceId: "space-b" },
    { apiBase: "https://other.example.test" },
  ])("never reads another scope %j", (change) => {
    writeIntegrationsCache(scope, snapshot);
    expect(readIntegrationsCache({ ...scope, ...change })).toBeNull();
  });
  it("treats corrupt files, mismatched keys, invalid rows, and disk failures as misses", () => {
    writeIntegrationsCache(scope, snapshot);
    const path = [...state.files.keys()][0]!;
    for (const value of [
      "{",
      JSON.stringify({ key: "wrong", ...snapshot }),
      JSON.stringify({
        key: JSON.stringify([scope.apiBase, scope.userId, scope.spaceId]),
        catalog: [{}],
        connections: [],
      }),
    ]) {
      state.files.set(path, value);
      expect(readIntegrationsCache(scope)).toBeNull();
    }
    state.broken = true;
    expect(() => writeIntegrationsCache(scope, snapshot)).not.toThrow();
  });
  it("reuses verified identity until the endpoint or Space changes", async () => {
    const first = await integrationsCacheScope();
    state.space = "space-b";
    expect((await integrationsCacheScope()).spaceId).toBe("space-b");
    expect(state.rpc).toHaveBeenCalledTimes(2);
    expect(isIntegrationsScopeCurrent(first)).toBe(false);
    state.base = "https://other.example.test";
    state.rpc.mockResolvedValue({ userId: "user-b", spaceId: "space-b" });
    expect((await integrationsCacheScope()).userId).toBe("user-b");
    expect(state.rpc).toHaveBeenCalledTimes(3);
  });
  it("rejects identity that returns after a Space change", async () => {
    let resolve!: (value: unknown) => void;
    state.rpc.mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const pending = integrationsCacheScope();
    state.space = "space-b";
    resolve({ userId: "user-a", spaceId: "space-a" });
    await expect(pending).rejects.toThrow("Could not load integrations");
  });
});

it("restores only the persisted verified scope without waiting for me", async () => {
  state.secure.set("rakazo.integrations-scope", JSON.stringify(scope));
  state.rpc.mockReturnValue(new Promise(() => {}));
  writeIntegrationsCache(scope, snapshot);
  const restored = await persistedIntegrationsCacheScope();
  expect(restored).toEqual(scope);
  expect(readIntegrationsCache(restored!)).toEqual(snapshot);
  expect(state.rpc).not.toHaveBeenCalled();
});
it.each(["server", "space"])("rejects a persisted scope after %s changes", async (change) => {
  state.secure.set("rakazo.integrations-scope", JSON.stringify(scope));
  if (change === "server") state.base = "https://other.example.test";
  else state.space = "space-b";
  expect(await persistedIntegrationsCacheScope()).toBeNull();
});
it("persists a scope only after successful identity verification", async () => {
  const verified = await integrationsCacheScope();
  expect(JSON.parse(state.secure.get("rakazo.integrations-scope") ?? "")).toEqual(verified);
  state.base = "https://other.example.test";
  state.rpc.mockRejectedValue(new Error("offline"));
  await expect(integrationsCacheScope()).rejects.toThrow("offline");
  expect(JSON.parse(state.secure.get("rakazo.integrations-scope") ?? "")).toEqual(verified);
});

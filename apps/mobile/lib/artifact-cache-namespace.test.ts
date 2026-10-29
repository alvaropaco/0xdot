import * as SecureStore from "expo-secure-store";
import { beforeEach, expect, it, vi } from "vitest";

const disk = vi.hoisted(() => new Map<string, string>());
vi.mock("expo-secure-store", () => ({
  getItemAsync: vi.fn(async (key: string) => disk.get(key) ?? null),
  setItemAsync: vi.fn(async (key: string, value: string) => {
    disk.set(key, value);
  }),
  deleteItemAsync: vi.fn(async (key: string) => {
    disk.delete(key);
  }),
}));
const load = () => import("./artifact-cache-namespace");

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  disk.clear();
});

it("restores the namespace after restart", async () => {
  const cache = await load();
  const namespace = await cache.artifactCacheNamespace();
  vi.resetModules();
  expect(await (await load()).artifactCacheNamespace()).toBe(namespace);
});

it("keeps one namespace per process even when persistence keeps failing", async () => {
  const cache = await load();
  vi.mocked(SecureStore.setItemAsync).mockRejectedValue(new Error("locked"));
  const fallback = await cache.artifactCacheNamespace();
  expect(await cache.artifactCacheNamespace()).toBe(fallback);
  // A namespace that could not persist never survives a restart.
  vi.resetModules();
  expect(await (await load()).artifactCacheNamespace()).not.toBe(fallback);
});

it("allows a cold cache when metadata cannot be read or written", async () => {
  const cache = await load();
  vi.mocked(SecureStore.getItemAsync).mockRejectedValueOnce(new Error("locked"));
  vi.mocked(SecureStore.setItemAsync).mockRejectedValueOnce(new Error("locked"));
  expect(await cache.artifactCacheNamespace()).toMatch(/^[a-z0-9]+-[a-z0-9]+$/);
  expect(disk.size).toBe(0);
});

it("ignores stored metadata in an unexpected shape", async () => {
  disk.set("rakazo.artifact-cache-namespace", JSON.stringify({ namespace: "not valid!" }));
  expect(await (await load()).artifactCacheNamespace()).toMatch(/^[a-z0-9]+-[a-z0-9]+$/);
});

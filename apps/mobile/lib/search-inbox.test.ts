import { beforeEach, expect, it, vi } from "vitest";
import type { InboxSpace } from "./inbox-spaces";
import { getSearchInbox, setSearchInbox, subscribeSearchInbox } from "./search-inbox";

const state = vi.hoisted(() => ({ apiBase: "https://example.test" }));
vi.mock("./api", () => ({ currentApiBase: () => state.apiBase }));
beforeEach(() => {
  state.apiBase = "https://example.test";
});
it("publishes the exact home roster and unsubscribes", () => {
  const listener = vi.fn();
  const unsubscribe = subscribeSearchInbox(listener);
  const spaces = [{ id: "space-a", bots: [], groups: [] }] as unknown as InboxSpace[];
  setSearchInbox(spaces);
  expect(getSearchInbox()).toBe(spaces);
  expect(listener).toHaveBeenCalledOnce();
  unsubscribe();
  setSearchInbox([]);
  expect(listener).toHaveBeenCalledOnce();
});
it("hides another server's roster", () => {
  const spaces = [{ id: "space-a", bots: [], groups: [] }] as unknown as InboxSpace[];
  const listener = vi.fn();
  const unsubscribe = subscribeSearchInbox(listener);
  setSearchInbox(spaces);
  state.apiBase = "https://other.example.test";
  expect(getSearchInbox()).toEqual([]);
  setSearchInbox(spaces);
  expect(getSearchInbox()).toBe(spaces);
  unsubscribe();
});

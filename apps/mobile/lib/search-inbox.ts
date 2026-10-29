import { currentApiBase } from "./api";
import type { InboxSpace } from "./inbox-spaces";

const empty: readonly InboxSpace[] = [];
let snapshot = empty;
let apiBase = "";
const listeners = new Set<() => void>();

// Share the home roster without another request or navigation payload.
export function setSearchInbox(spaces: readonly InboxSpace[]): void {
  snapshot = spaces;
  apiBase = currentApiBase();
  for (const listener of listeners) listener();
}

export function getSearchInbox(): readonly InboxSpace[] {
  return apiBase === currentApiBase() ? snapshot : empty;
}

export function subscribeSearchInbox(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

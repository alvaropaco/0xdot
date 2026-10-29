import * as SecureStore from "expo-secure-store";

const KEY = "rakazo.artifact-cache-namespace";
let writes: Promise<unknown> = Promise.resolve();
let active: string | undefined;

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const next = writes.then(task, task);
  writes = next.catch(() => undefined);
  return next;
}

function newNamespace(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/** One long-lived cache scope per install: disk paths carry only this opaque namespace. */
export function artifactCacheNamespace(): Promise<string> {
  return enqueue(async (): Promise<string> => {
    if (active) return active;
    try {
      const stored = JSON.parse((await SecureStore.getItemAsync(KEY)) || "null");
      if (
        stored &&
        typeof stored.namespace === "string" &&
        /^[a-z0-9]+-[a-z0-9]+$/.test(stored.namespace)
      ) {
        active = stored.namespace;
        return stored.namespace;
      }
    } catch {
      // Missing or invalid metadata is a cold cache.
    }
    active = newNamespace();
    try {
      await SecureStore.setItemAsync(KEY, JSON.stringify({ namespace: active }));
    } catch {
      // The namespace survives in memory for this process; paths stay opaque either way.
    }
    return active;
  });
}

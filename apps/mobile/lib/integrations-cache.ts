import type { Connection, ConnectionCatalogItem, Me } from "@rakazo/contracts";
import { ConnectionCatalogItemSchema, ConnectionSchema } from "@rakazo/contracts";
import { Directory, File, Paths } from "expo-file-system";
import * as SecureStore from "expo-secure-store";
import { currentApiBase, rpc, selectedSpaceId } from "./api";
import { t } from "./i18n";

export type IntegrationsSnapshot = {
  catalog: ConnectionCatalogItem[];
  connections: Connection[];
};
export type IntegrationsCacheScope = {
  apiBase: string;
  userId: string;
  spaceId: string;
  selectionId: string | null;
};

// Reuse the deployment owner the server verified for this endpoint until the server changes.
let identity:
  | {
      apiBase: string;
      selectionId: string | null;
      user: Promise<Pick<Me, "userId" | "spaceId">>;
    }
  | undefined;

const SCOPE_KEY = "rakazo.integrations-scope";
let scopeWrites: Promise<void> = Promise.resolve();

function enqueueScopeWrite<T>(task: () => Promise<T>): Promise<T> {
  const next = scopeWrites.then(task, task);
  scopeWrites = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

/** The deployment owner the server last verified for this app, for cache paths that
 * must not mix another server's owner. Reads fail closed when storage is unreadable. */
export async function loadVerifiedIntegrationsScope(): Promise<IntegrationsCacheScope | null> {
  try {
    const stored = await SecureStore.getItemAsync(SCOPE_KEY);
    if (!stored) return null;
    const data = JSON.parse(stored);
    if (
      typeof data.apiBase !== "string" ||
      !data.apiBase ||
      typeof data.userId !== "string" ||
      !data.userId ||
      typeof data.spaceId !== "string" ||
      !data.spaceId ||
      !(data.selectionId === null || typeof data.selectionId === "string")
    )
      return null;
    return {
      apiBase: data.apiBase,
      userId: data.userId,
      spaceId: data.spaceId,
      selectionId: data.selectionId,
    };
  } catch {
    return null;
  }
}

export function saveVerifiedIntegrationsScope(scope: IntegrationsCacheScope): Promise<void> {
  return enqueueScopeWrite(async () => {
    try {
      await SecureStore.setItemAsync(SCOPE_KEY, JSON.stringify(scope));
    } catch {
      // Verified scope persistence is optional.
    }
  });
}

export async function persistedIntegrationsCacheScope(): Promise<IntegrationsCacheScope | null> {
  const saved = await loadVerifiedIntegrationsScope();
  if (!saved) return null;
  return isIntegrationsScopeCurrent(saved) ? saved : null;
}

export async function integrationsCacheScope(): Promise<IntegrationsCacheScope> {
  const apiBase = currentApiBase();
  const spaceId = selectedSpaceId();
  if (!identity || identity.apiBase !== apiBase || identity.selectionId !== spaceId) {
    const user = rpc<Pick<Me, "userId" | "spaceId">>("me");
    const entry = { apiBase, selectionId: spaceId, user };
    identity = entry;
    void user.catch(() => {
      if (identity === entry) identity = undefined;
    });
  }
  const me = await identity.user;
  if (apiBase !== currentApiBase() || spaceId !== selectedSpaceId())
    throw new Error(t("Could not load integrations"));
  if (!me.userId || !(spaceId || me.spaceId)) throw new Error(t("Could not load integrations"));
  const scope = {
    apiBase,
    userId: me.userId,
    spaceId: spaceId || me.spaceId,
    selectionId: spaceId,
  };
  void saveVerifiedIntegrationsScope(scope);
  return scope;
}

export function isIntegrationsScopeCurrent(scope: IntegrationsCacheScope): boolean {
  return scope.apiBase === currentApiBase() && scope.selectionId === selectedSpaceId();
}

function scopeKey(scope: IntegrationsCacheScope): string {
  return JSON.stringify([scope.apiBase, scope.userId, scope.spaceId]);
}

function cacheFile(scope: IntegrationsCacheScope): File {
  const root = new Directory(
    Paths.cache,
    "integrations-v1",
    encodeURIComponent(scope.apiBase),
    `user-${encodeURIComponent(scope.userId)}`,
  );
  if (!root.exists) root.create({ intermediates: true, idempotent: true });
  return new File(root, `${encodeURIComponent(scope.spaceId)}.json`);
}

export function readIntegrationsCache(scope: IntegrationsCacheScope): IntegrationsSnapshot | null {
  try {
    const file = cacheFile(scope);
    if (!file.exists) return null;
    const data = JSON.parse(file.textSync());
    if (
      data.key !== scopeKey(scope) ||
      !Array.isArray(data.catalog) ||
      !Array.isArray(data.connections)
    )
      return null;
    return {
      catalog: data.catalog.map((item: unknown) => ConnectionCatalogItemSchema.parse(item)),
      connections: data.connections.map((item: unknown) => ConnectionSchema.parse(item)),
    };
  } catch {
    // OS eviction, corrupt files, and unavailable storage are all cold misses.
    return null;
  }
}

export function writeIntegrationsCache(
  scope: IntegrationsCacheScope,
  snapshot: IntegrationsSnapshot,
): void {
  try {
    const file = cacheFile(scope);
    file.create({ overwrite: true });
    file.write(JSON.stringify({ key: scopeKey(scope), ...snapshot }));
  } catch {
    // Disk cache is optional; storage failures must not block connection actions.
  }
}

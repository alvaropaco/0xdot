import { isModelRequiredSendError } from "@rakazo/core";
import { Alert, AppState } from "react-native";
import {
  captureApiRequestContext,
  currentApiBase,
  isServerReachable,
  rpc,
  selectedSpaceId,
  subscribeServerReachable,
} from "./api";
import { artifactCacheNamespace } from "./artifact-cache-namespace";
import { t } from "./i18n";
import { integrationsCacheScope, loadVerifiedIntegrationsScope } from "./integrations-cache";
import { openModelSettings } from "./model-settings";
import { outboxDisk } from "./outbox-disk";
import type { OutboxScope } from "./thread-feedback";
import { configureUnsentSends, restoreUnsentSends, sendWaitingMessages } from "./thread-feedback";
import { errorText } from "./user-error";

let activeScope: OutboxScope | null = null;
function scope() {
  return activeScope && activeScope.apiBase === currentApiBase() ? activeScope : null;
}
export async function prepareUnsentSends(): Promise<void> {
  const apiBase = currentApiBase();
  const spaceId = selectedSpaceId();
  if (!scope() || activeScope?.spaceId !== spaceId) {
    const saved = await loadVerifiedIntegrationsScope();
    const verified =
      saved?.apiBase === apiBase && (spaceId || saved.selectionId === null)
        ? saved
        : await integrationsCacheScope();
    const cacheNamespace = await artifactCacheNamespace();
    if (apiBase !== currentApiBase() || spaceId !== selectedSpaceId())
      throw new Error(t("Failed to send message"));
    activeScope = {
      apiBase,
      spaceId: spaceId ?? verified.spaceId,
      userId: verified.userId,
      cacheSession: cacheNamespace,
    };
  }
  restoreUnsentSends();
}
// Configure the outbox before bootstrap can replace the server or the saved Space.
configureUnsentSends({
  request: async <T>(
    proc: string,
    body: unknown,
    options: Parameters<typeof rpc>[2],
    spaceId: string | null,
  ) => {
    const context = await captureApiRequestContext();
    const headers = { ...context.headers };
    if (spaceId) headers["x-rakazo-space-id"] = spaceId;
    else delete headers["x-rakazo-space-id"];
    return rpc<T>(proc, body, { ...options, requestContext: { ...context, headers } });
  },
  serverReachable: isServerReachable,
  scope,
  disk: outboxDisk,
  errorText: (error) => errorText(error, t("Failed to send message")),
  notDelivered: (attempt) => {
    if (isModelRequiredSendError(attempt.error)) {
      Alert.alert(t("Add an AI model to keep chatting"), undefined, [
        { text: t("Not Now"), style: "cancel" },
        { text: t("Add Model"), onPress: openModelSettings, isPreferred: true },
      ]);
    } else {
      Alert.alert(t("Failed to send message"), attempt.error);
    }
  },
});
export function startUnsentSends(): () => void {
  let stopped = false;
  const retry = (force = false) =>
    void prepareUnsentSends()
      .then(() => {
        if (!stopped) return sendWaitingMessages(force);
      })
      .catch(() => undefined);
  retry();
  const reachable = subscribeServerReachable(() => {
    if (isServerReachable()) retry();
  });
  const appState = AppState.addEventListener("change", (state) => {
    if (state === "active") retry(true);
  });
  return () => {
    stopped = true;
    reachable();
    appState.remove();
  };
}

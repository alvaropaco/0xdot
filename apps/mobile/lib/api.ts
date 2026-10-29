import type {
  Bot,
  BotSection,
  ComputerMode,
  Group,
  Me,
  MessageBlock,
  ModelCatalogEntry,
  ModelCredential,
  ReplyPreview,
  RunStatus,
  Space,
  SpaceNavigation,
} from "@rakazo/contracts";
import { CLIENT_UPDATE_REQUIRED_STATUS } from "@rakazo/contracts";
import type { ThreadHistory } from "@rakazo/core";
import {
  aiConsentTarget,
  aiDataUsesForProcedure,
  cancelResponseBody,
  displayIdentityEvent,
  displayIdentityResult,
  ensureAiDataConsent,
  isActive,
  isBackgroundRunTrigger,
  isRunTerminalEvent,
  isServerUnreachable,
  isUnreachableStatus,
  mergeThreadHistory,
  messagingProviderLabel,
  parseRetryAfter,
  prependThreadHistoryPage,
  progressMessageId,
  readBoundedJsonResponse,
  reduceLiveMessageBlocks,
  replyMetadata,
  runFailureError,
  settleRunSubagents,
  stopsRunHelpers,
  takeLiveMessage,
  updateCloudAgentMessages,
  upsertMessageById,
} from "@rakazo/core";
import { clientCorrelationHeaders, responseCorrelation } from "@rakazo/logging/monitoring";
import * as SecureStore from "expo-secure-store";
import { promptAiConsent } from "./ai-consent";
import type { EndpointResult } from "./endpoint";
import { defaultApiBase, normalizeApiBase } from "./endpoint";
import { t } from "./i18n";
import { identityLabels } from "./identity-display";
import { resumeLiveNotifications } from "./live-notifications";
import { reportMobileError } from "./monitoring";
import { clearUnsentSends } from "./thread-feedback";
import { errorText } from "./user-error";

const ENDPOINT_KEY = "rakazo.api_base";
const SPACE_KEY = "rakazo.space_id";
const SPACE_ROLLBACK_KEY = "rakazo.space_rollback";
const RPC_TIMEOUT_MS = 8_000;
export const MAX_MOBILE_RPC_RESPONSE_BYTES = 16 * 1024 * 1024;

let cachedApiBase: string | undefined;
const apiBaseListeners = new Set<() => void>();

export function subscribeApiBase(listener: () => void): () => void {
  apiBaseListeners.add(listener);
  return () => {
    apiBaseListeners.delete(listener);
  };
}

function setCachedApiBase(url: string): void {
  if (cachedApiBase !== undefined && cachedApiBase !== url) clearUnsentSends();
  cachedApiBase = url;
  for (const listener of apiBaseListeners) listener();
}
let cachedSpaceId = "";
/** Bumped on every in-memory Space selection change so a delayed response
 * cannot treat a later reselection of the same Space id as its own. */
let spaceSelectionGeneration = 0;
/** Counts selectSpace attempts so one still cleaning up a rollback record
 * cannot claim the selection after a newer attempt has started. */
let spaceSelectionRequestGeneration = 0;

/** Includes pending selections that have not claimed the in-memory space yet. */
export function spaceSelectionSeq(): number {
  return spaceSelectionRequestGeneration;
}

function bumpSpaceSelectionGeneration(): void {
  spaceSelectionGeneration += 1;
}

/** Keeps a timeout or cancel reason; turns transport and parsing detail into copy. */
function requestError(error: unknown, signal: AbortSignal): unknown {
  return signal.aborted ? (signal.reason ?? error) : new Error(errorText(error), { cause: error });
}

let serverReachable = true;
const serverReachableListeners = new Set<() => void>();

/** False from a request that could not reach the server until the server answers again. */
export function isServerReachable(): boolean {
  return serverReachable;
}

/** Calls `listener` each time the server stops or starts answering. */
export function subscribeServerReachable(listener: () => void): () => void {
  serverReachableListeners.add(listener);
  return () => {
    serverReachableListeners.delete(listener);
  };
}

function noteServerReachable(reachable: boolean): void {
  if (reachable === serverReachable) return;
  serverReachable = reachable;
  for (const listener of [...serverReachableListeners]) listener();
}

export function currentApiBase() {
  const parsed = normalizeApiBase(cachedApiBase ?? defaultApiBase());
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.url;
}

export async function loadApiBase() {
  let apiBase = defaultApiBase();
  try {
    const stored = await SecureStore.getItemAsync(ENDPOINT_KEY);
    if (stored) {
      const parsed = normalizeApiBase(stored);
      if (parsed.ok) {
        apiBase = parsed.url;
      }
    }
  } catch {
    // SecureStore is unavailable in some test / web hosts.
  }
  setCachedApiBase(apiBase);
  try {
    const storedSpace = (await SecureStore.getItemAsync(SPACE_KEY)) ?? "";
    cachedSpaceId = storedSpace;
    bumpSpaceSelectionGeneration();
    // A deletion fallback must override the now-invalid saved Space even when
    // the device failed to replace that value before the previous process exited.
    await recoverSpaceRollback(apiBase);
  } catch {
    // Keep any in-memory selection when SecureStore is temporarily unavailable.
  }
  return currentApiBase();
}

export async function selectSpace(id: string) {
  const requestGeneration = ++spaceSelectionRequestGeneration;
  if (!(await clearStoredValue(SPACE_ROLLBACK_KEY))) return false;
  // Rollback cleanup is the first await. A newer selection may have claimed
  // the live space while this call was still deleting the rollback record.
  if (requestGeneration !== spaceSelectionRequestGeneration) return false;
  // Claim memory before persisting: recovery paths reconcile against the
  // in-memory selection, so a durable write must never precede its owner.
  const previousSpaceId = cachedSpaceId;
  cachedSpaceId = id;
  bumpSpaceSelectionGeneration();
  // Generation ownership distinguishes A→B→A from "we still own this claim":
  // an ID-only check would treat a later same-id selection as ours.
  const claimGeneration = spaceSelectionGeneration;
  try {
    await SecureStore.setItemAsync(SPACE_KEY, id);
    // Our write may have landed stale behind a newer overlapping selection's
    // write. Re-assert the live selection best-effort so durable converges
    // to it; each selector heals at most once, so overlapping chains settle
    // on the latest claim. Never delete here: a missing memory owner means
    // another path (recovery, sign-out) owns cleanup.
    const liveSpaceId = cachedSpaceId;
    if (liveSpaceId && liveSpaceId !== id) {
      await writeStoredValue(SPACE_KEY, liveSpaceId);
    }
  } catch {
    // Roll back the claim and heal durable state: a concurrent recovery may
    // have persisted the rolled-back id after reading it, which would leave
    // restart opening a Space the live session is not using. A newer
    // overlapping selection owns both by now, so only heal a claim we hold.
    if (cachedSpaceId === id && spaceSelectionGeneration === claimGeneration) {
      cachedSpaceId = previousSpaceId;
      bumpSpaceSelectionGeneration();
      if (previousSpaceId) await writeStoredValue(SPACE_KEY, previousSpaceId);
    }
    return false;
  }
  await resumeLiveNotifications(currentApiBase(), id).catch(() => undefined);
  return true;
}

export function selectedSpaceId(): string | null {
  return cachedSpaceId || null;
}

/** Keep requests usable after the server deleted the selected Space but native
 * storage could not replace it. Neutralize any same-endpoint rollback before
 * writing the replacement selection so a cleanup failure cannot leave the new
 * id beside a stale record that recoverSpaceRollback would prefer on restart. */
export async function adoptDeletedSpaceFallback(id: string): Promise<boolean> {
  cachedSpaceId = id;
  bumpSpaceSelectionGeneration();
  // Neutralize any same-endpoint rollback before writing SPACE_KEY. Writing the
  // selection first can leave it beside a stale record that recoverSpaceRollback
  // would prefer on restart if later cleanup fails.
  const rollbackNeutralized =
    (await clearStoredValue(SPACE_ROLLBACK_KEY)) || (await saveSpaceRollback(id));
  if (rollbackNeutralized && (await writeStoredValue(SPACE_KEY, id))) {
    // SPACE_KEY is authoritative; drop a rollback we may have written only to
    // overwrite a stale record (best-effort).
    await clearStoredValue(SPACE_ROLLBACK_KEY);
    await resumeLiveNotifications(currentApiBase(), id).catch(() => undefined);
    return true;
  }
  // Clear before saving recovery: an empty selection lets startup resolve the
  // server default even when the recovery record cannot be written.
  const staleSelectionCleared = await clearStoredValue(SPACE_KEY);
  const recoverySaved = await saveSpaceRollback(id);
  await resumeLiveNotifications(currentApiBase(), id).catch(() => undefined);
  // Only treat a cleared selection as durable success when no same-endpoint
  // rollback remains to override it after restart.
  return recoverySaved || (staleSelectionCleared && (await clearStoredValue(SPACE_ROLLBACK_KEY)));
}

export async function selectInitialSpace(id: string) {
  if (selectedSpaceId()) return true;
  return selectSpace(id);
}

async function clearStoredValue(key: string): Promise<boolean> {
  try {
    await SecureStore.deleteItemAsync(key);
    return true;
  } catch {
    return writeStoredValue(key, "");
  }
}

async function writeStoredValue(key: string, value: string): Promise<boolean> {
  try {
    await SecureStore.setItemAsync(key, value);
    return true;
  } catch {
    return false;
  }
}

async function snapshotSpace(): Promise<{ ok: true; value: string } | { ok: false }> {
  if (cachedSpaceId) return { ok: true, value: cachedSpaceId };
  try {
    return { ok: true, value: (await SecureStore.getItemAsync(SPACE_KEY)) ?? "" };
  } catch {
    return { ok: false };
  }
}

/** Clears the Space selection for an endpoint change. Restores it if the wipe fails. */
async function clearSpaceForEndpointChange(): Promise<
  | {
      ok: true;
      previousSpace: string;
    }
  | { ok: false; result: EndpointResult }
> {
  const previousSpace = await snapshotSpace();
  if (!previousSpace.ok) {
    return {
      ok: false,
      result: { ok: false, error: t("Could not switch servers") },
    };
  }
  const rollbackReady = previousSpace.value
    ? await saveSpaceRollback(previousSpace.value)
    : await clearStoredValue(SPACE_ROLLBACK_KEY);
  if (!rollbackReady) {
    return {
      ok: false,
      result: { ok: false, error: t("Could not switch servers") },
    };
  }
  cachedSpaceId = "";
  bumpSpaceSelectionGeneration();
  const spaceCleared = await clearStoredValue(SPACE_KEY);
  if (spaceCleared) {
    return {
      ok: true,
      previousSpace: previousSpace.value,
    };
  }

  await restoreSpace(previousSpace.value);
  return {
    ok: false,
    result: { ok: false, error: t("Could not switch servers") },
  };
}

async function restoreSpace(previousSpace: string) {
  if (previousSpace) {
    cachedSpaceId = previousSpace;
    bumpSpaceSelectionGeneration();
    try {
      await SecureStore.setItemAsync(SPACE_KEY, previousSpace);
      await clearStoredValue(SPACE_ROLLBACK_KEY);
    } catch {
      // The endpoint-bound rollback record restores this selection after restart.
    }
    await resumeLiveNotifications(currentApiBase(), previousSpace).catch(() => undefined);
  }
}

async function saveSpaceRollback(spaceId: string): Promise<boolean> {
  return writeStoredValue(
    SPACE_ROLLBACK_KEY,
    JSON.stringify({ apiBase: currentApiBase(), spaceId }),
  );
}

async function recoverSpaceRollback(apiBase: string) {
  const stored = await SecureStore.getItemAsync(SPACE_ROLLBACK_KEY);
  if (!stored) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(stored);
  } catch {
    await clearStoredValue(SPACE_ROLLBACK_KEY);
    return;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    await clearStoredValue(SPACE_ROLLBACK_KEY);
    return;
  }
  const rollback = parsed as { apiBase?: unknown; spaceId?: unknown };
  if (rollback.apiBase !== apiBase || typeof rollback.spaceId !== "string" || !rollback.spaceId) {
    await clearStoredValue(SPACE_ROLLBACK_KEY);
    return;
  }
  cachedSpaceId = rollback.spaceId;
  bumpSpaceSelectionGeneration();
  if (await writeStoredValue(SPACE_KEY, rollback.spaceId)) {
    await clearStoredValue(SPACE_ROLLBACK_KEY);
    return;
  }
  // Could not replace the selection yet. Drop the deleted id so startup RPCs
  // are not scoped to an inaccessible Space; keep the recovery record.
  await clearStoredValue(SPACE_KEY);
}

export async function saveApiBase(input: string): Promise<EndpointResult> {
  const parsed = normalizeApiBase(input);
  if (!parsed.ok) return parsed;
  if (parsed.url === defaultApiBase()) return resetApiBase();
  const previous = currentApiBase();
  let cleared:
    | {
        previousSpace: string;
      }
    | undefined;
  if (parsed.url !== previous) {
    const result = await clearSpaceForEndpointChange();
    if (!result.ok) return result.result;
    cleared = result;
  }
  try {
    await SecureStore.setItemAsync(ENDPOINT_KEY, parsed.url);
  } catch {
    if (cleared) {
      await restoreSpace(cleared.previousSpace);
    }
    return { ok: false, error: t("Could not save the server URL") };
  }
  setCachedApiBase(parsed.url);
  await clearStoredValue(SPACE_ROLLBACK_KEY);
  return parsed;
}

export async function resetApiBase(): Promise<EndpointResult> {
  const previous = currentApiBase();
  const url = defaultApiBase();
  let cleared:
    | {
        previousSpace: string;
      }
    | undefined;
  if (url !== previous) {
    const result = await clearSpaceForEndpointChange();
    if (!result.ok) return result.result;
    cleared = result;
  }
  try {
    await SecureStore.deleteItemAsync(ENDPOINT_KEY);
  } catch {
    if (cleared) {
      await restoreSpace(cleared.previousSpace);
      return { ok: false, error: t("Could not clear the custom server URL") };
    }
  }
  setCachedApiBase(url);
  await clearStoredValue(SPACE_ROLLBACK_KEY);
  return { ok: true, url };
}

let clientBuild: { headers: () => Record<string, string>; onUpdateRequired: () => void } = {
  headers: () => ({}),
  onUpdateRequired: () => {},
};

/** The app names its build on every request and decides what a refused build does. */
export function configureClientBuild(options: typeof clientBuild): void {
  clientBuild = options;
}

export async function requestHeaders(
  spaceId: string | null = selectedSpaceId(),
): Promise<Record<string, string>> {
  return {
    ...clientBuild.headers(),
    ...(spaceId ? { "x-rakazo-space-id": spaceId } : {}),
  };
}

export type ApiRequestContext = {
  apiBase: string;
  headers: Record<string, string>;
};

/** Keeps consent prompts separate across servers and the selected Space. */
export function aiConsentCoalesceKey(requestContext: ApiRequestContext): string {
  return [requestContext.apiBase, requestContext.headers["x-rakazo-space-id"] ?? ""].join("\u0000");
}

export async function captureApiRequestContext(): Promise<ApiRequestContext> {
  const apiBase = currentApiBase();
  const headers = await requestHeaders(selectedSpaceId());
  if (apiBase !== currentApiBase()) {
    throw new Error(t("The server changed while starting the request"));
  }
  return { apiBase, headers };
}

export async function rpc<T>(
  proc: string,
  body: unknown = {},
  options: {
    signal?: AbortSignal;
    timeoutMs?: number | null;
    requestContext?: ApiRequestContext;
  } = {},
): Promise<T> {
  const requestApiBase = options.requestContext?.apiBase ?? currentApiBase();
  const uses = aiDataUsesForProcedure(proc, body);
  const consentContext =
    options.requestContext ?? (uses.length ? await captureApiRequestContext() : undefined);
  await ensureAiDataConsent({
    uses,
    status: () =>
      rpc(
        "aiConsent/status",
        { uses, ...aiConsentTarget(body) },
        { requestContext: consentContext },
      ),
    prompt: promptAiConsent,
    allow: (input) => rpc("aiConsent/allow", input, { requestContext: consentContext }),
    coalesceKey: consentContext ? aiConsentCoalesceKey(consentContext) : undefined,
  });
  // Abort with an explicit reason so every consumer of the signal (the fetch, the bounded body
  // read, and nested recovery calls that share this signal) reports the same cause.
  const controller = new AbortController();
  const cancel = () => controller.abort(options.signal?.reason ?? new Error("Request canceled"));
  if (options.signal?.aborted) cancel();
  else options.signal?.addEventListener("abort", cancel, { once: true });
  const timer =
    options.timeoutMs === null
      ? undefined
      : setTimeout(
          () =>
            controller.abort(
              Object.defineProperty(new Error("Request timed out"), "name", {
                value: "TimeoutError",
              }),
            ),
          options.timeoutMs ?? RPC_TIMEOUT_MS,
        );
  const headers = consentContext?.headers ?? (await requestHeaders());
  try {
    let res: Response;
    const correlation = clientCorrelationHeaders();
    try {
      res = await fetch(`${consentContext?.apiBase ?? currentApiBase()}/rpc/${proc}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "rakazo://",
          ...headers,
          ...correlation,
        },
        body: JSON.stringify({ json: body }),
        signal: controller.signal,
      });
    } catch (error) {
      // The native fetch reports an aborted request with an implementation detail
      // ("FetchRequestCanceledException") and an unreachable server with a native stack
      // location; say what happened instead.
      if (!controller.signal.aborted)
        reportMobileError(error, "rpc.transport", responseCorrelation(new Headers(correlation)));
      throw requestError(error, controller.signal);
    }
    if (requestApiBase === currentApiBase()) noteServerReachable(!isUnreachableStatus(res.status));
    if (proc === "aiConsent/status" && res.status === 404) {
      cancelResponseBody(res);
      throw new Error(t("Update your server to use AI data sharing in this mobile version."));
    }
    const parsed: { json?: T } = await readBoundedJsonResponse<{ json?: T }>(
      res,
      MAX_MOBILE_RPC_RESPONSE_BYTES,
      controller.signal,
    ).catch((error: unknown) => {
      // A proxy, or a server without this procedure, can fail with a body that is not JSON.
      if (!res.ok && error instanceof SyntaxError) return {};
      throw requestError(error, controller.signal);
    });
    if (!res.ok) {
      // oRPC sends a failure as `{ json: { code, status, message } }`; the message is the
      // server's user-facing copy.
      const error = parsed.json as { message?: unknown; code?: unknown } | undefined;
      const message = errorText(typeof error?.message === "string" ? error.message : "");
      throw httpError(message, res, typeof error?.code === "string" ? error.code : undefined);
    }
    return displayIdentityResult(proc.split("/"), parsed.json, identityLabels()) as T;
  } catch (error) {
    if (requestApiBase === currentApiBase() && isServerUnreachable(error))
      noteServerReachable(false);
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
    options.signal?.removeEventListener("abort", cancel);
  }
}

export type MobileBot = Pick<
  Bot,
  | "id"
  | "name"
  | "preview"
  | "title"
  | "color"
  | "instructionHistory"
  | "selfUpdateInstructions"
  | "notifyOnFinish"
  | "threadId"
  | "pinned"
  | "status"
  | "sectionId"
  | "archivedAt"
  | "unread"
  | "updatedAt"
  | "computerMode"
  | "modelProvider"
  | "modelId"
  | "thinkingLevel"
  | "autoSpeak"
  | "fleetManagement"
  | "crossSpaceCommunication"
> &
  Partial<Pick<Bot, "parentBotId" | "spaceId" | "instructions">>;

export type MobileBotSection = BotSection;

export type MobileMe = Pick<
  Me,
  | "userId"
  | "spaceId"
  | "defaultProvider"
  | "defaultModel"
  | "hostCredentialProvider"
  | "hostCredentialSource"
  | "needsModel"
>;

export type MobileModel = ModelCatalogEntry;

/** Shared DTO includes headerNames only; header values remain in the server secret. */
export type MobileModelCredential = ModelCredential;

export type MobileMessage = {
  id: string;
  threadId?: string;
  seq?: number;
  runId?: string;
  role: "user" | "bot" | "system";
  /** Set when the message was sent from a live voice call; groups one call's transcript. */
  callId?: string;
  botId?: string;
  replyToMessageId?: string;
  replyQuote?: string;
  replyPreview?: ReplyPreview | null;
  createdAt?: string;
  blocks: MessageBlock[];
};

export type MobileGroup = Pick<
  Group,
  | "id"
  | "name"
  | "preview"
  | "pinned"
  | "sectionId"
  | "archivedAt"
  | "unread"
  | "updatedAt"
  | "members"
> &
  Partial<Pick<Group, "spaceId">>;

export type MobileSpace = Space;
export type MobileSpaceNavigation = SpaceNavigation;

export type MobileSnapshot = {
  botId?: string;
  groupId?: string;
  groupName?: string;
  threadId: string;
  cursor?: number;
  messages: MobileMessage[];
  olderCursor: number | null;
  run: { id: string; botId?: string; status: string; error?: string | null } | null;
  activeRuns?: Array<{ id: string; botId?: string; status: string }>;
  members?: MobileGroup["members"];
  computer?: {
    state: string;
    controlHolder: string;
    screenAvailable: boolean;
    mode: ComputerMode;
    busyBotName: string | null;
  };
};

export function shouldApplyMobileThreadRefresh(input: {
  requestEpoch: number;
  currentEpoch: number;
  targetBotId: string | undefined;
  targetGroupId: string | undefined;
  activeBotId: string | undefined;
  activeGroupId: string | undefined;
}) {
  return (
    input.requestEpoch === input.currentEpoch &&
    input.targetBotId === input.activeBotId &&
    input.targetGroupId === input.activeGroupId
  );
}

/**
 * What a refresh may hand the live subscription. The server replays events
 * after this snapshot's cursor, so an uncommitted fetch must not supply it.
 */
export function mobileThreadRefreshResult(input: {
  fetched: MobileSnapshot;
  onScreen: MobileSnapshot | null;
  requestGeneration: number;
  currentGeneration: number;
  requestEpoch: number;
  currentEpoch: number;
  targetBotId: string | undefined;
  targetGroupId: string | undefined;
  activeBotId: string | undefined;
  activeGroupId: string | undefined;
}): { commit: boolean; snapshot: MobileSnapshot | null } {
  // Live events may advance the screen while this snapshot is in flight.
  const commit =
    input.requestGeneration === input.currentGeneration &&
    shouldApplyMobileThreadRefresh(input) &&
    (input.onScreen?.threadId !== input.fetched.threadId ||
      (input.fetched.cursor ?? -1) >= (input.onScreen.cursor ?? -1));
  return { commit, snapshot: commit ? input.fetched : input.onScreen };
}

export type MobileMessagePage = ThreadHistory<MobileMessage>;

export function mergeMobileSnapshot(
  prev: MobileSnapshot | null,
  next: MobileSnapshot,
  preserveLoadedHistory = false,
): MobileSnapshot {
  return mergeThreadHistory(prev, next, preserveLoadedHistory);
}

export function prependMobileMessagePage(
  prev: MobileSnapshot | null,
  page: MobileMessagePage,
): MobileSnapshot | null {
  return prependThreadHistoryPage(prev, page);
}

export { messagingProviderLabel };

/** The message's text exactly as written, for a view that selects part of it. */
export function selectableMobileMessageText(message: MobileMessage): string {
  return message.blocks
    .map((block) => {
      if (block.kind === "channel_message") {
        return `${messagingProviderLabel(block.provider, block.transport)} · ${block.fromLabel}: ${block.text}`;
      }
      if (block.kind === "text" || block.kind === "progress" || block.kind === "ask")
        return block.text;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

export function copyableMobileMessageText(message: MobileMessage): string {
  return selectableMobileMessageText(message).trim();
}

export function blockText(message: MobileMessage) {
  return message.blocks
    .map((block) => {
      if (block.kind === "channel_message") {
        return `${messagingProviderLabel(block.provider, block.transport)} · ${block.fromLabel}: ${block.text}`;
      }
      if (block.kind === "cloud_agent")
        return `${block.title}: ${block.status}${block.prUrl ? ` ${block.prUrl}` : ""}`;
      if (block.kind === "subagent") {
        return `${block.name ?? "subagent"}: ${block.result || block.progress || block.task || ""}`;
      }
      if (block.kind === "child_bot") {
        return `${block.status === "archived" ? "Archived" : block.status === "deleted" ? "Deleted" : "Bot"} ${block.name ?? ""}`;
      }
      if (block.kind === "chart") return `[chart: ${block.name ?? "chart"}]`;
      if (block.kind === "image") return `[image: ${block.name ?? "attachment"}]`;
      if (block.kind === "file") {
        return `[file: ${block.name ?? "attachment"}${block.size ? ` (${block.size} bytes)` : ""}]`;
      }
      if (block.kind === "steps") {
        return (block.steps ?? [])
          .map((step) => `${step.label}${step.count > 1 ? ` ×${step.count}` : ""}`)
          .join(" · ");
      }
      return ("text" in block ? block.text : "state" in block ? block.state : "") ?? "";
    })
    .filter(Boolean)
    .join("\n");
}

type ThreadEvent = {
  id?: string;
  createdAt?: string;
  botId?: string;
  type: string;
  seq?: number;
  runId?: string;
  payload?: Record<string, unknown>;
};

/** No frame at all for this long means the stream is half-open; the server beats far faster. */
export const IDLE_TIMEOUT_MS = 45_000;

/**
 * A failed response as an error the shared retry policy can read: its status, oRPC code, and any
 * Retry-After. A 426 also asks the user to update, from whichever request noticed it.
 */
function httpError(message: string, res: Response, code?: string): Error {
  if (res.status === CLIENT_UPDATE_REQUIRED_STATUS) clientBuild.onUpdateRequired();
  return Object.defineProperties(new Error(message), {
    status: { value: res.status },
    // oRPC's error code; a proxy's bare 404 has none.
    code: { value: code },
    retryAfterMs: { value: parseRetryAfter(res.headers.get("retry-after")) },
  });
}

export async function subscribeThread(
  target: { botId: string } | { groupId: string },
  cursor: number,
  onEvent: (event: ThreadEvent) => void,
  signal: AbortSignal,
) {
  const context = await captureApiRequestContext();
  const current = () => context.apiBase === currentApiBase();
  const res = await fetch(`${context.apiBase}/rpc/threads/subscribe`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "text/event-stream",
      origin: "rakazo://",
      ...context.headers,
    },
    body: JSON.stringify({ json: { ...target, cursor } }),
    signal,
  }).catch((error: unknown) => {
    if (current() && !signal.aborted && isServerUnreachable(error)) noteServerReachable(false);
    throw error;
  });
  if (current()) noteServerReachable(!isUnreachableStatus(res.status));
  if (!res.ok || !res.body) {
    cancelResponseBody(res);
    throw httpError(`rpc threads/subscribe failed (${res.status})`, res);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (!signal.aborted) {
    // A half-open socket never reports done, so give up on silence and let the caller reconnect.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = await Promise.race([
      reader.read().catch((error) => {
        if (current() && !signal.aborted && isServerUnreachable(error)) noteServerReachable(false);
        throw error;
      }),
      new Promise<"idle">((resolve) => {
        timer = setTimeout(() => resolve("idle"), IDLE_TIMEOUT_MS);
      }),
    ]).finally(() => clearTimeout(timer));
    if (read === "idle") {
      void reader.cancel().catch(() => undefined);
      return;
    }
    const { done, value } = read;
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const chunks = buffer.split("\n\n");
    buffer = chunks.pop() ?? "";
    for (const chunk of chunks) {
      const data = chunk
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .join("");
      if (!data || data === "[DONE]") continue;
      try {
        const parsed = JSON.parse(data) as { json?: ThreadEvent; error?: { message?: string } };
        // Heartbeats prove liveness only; forwarding one would advance the caller's cursor.
        if (parsed.json?.type && parsed.json.type !== "heartbeat")
          onEvent(displayIdentityEvent(parsed.json, identityLabels()));
      } catch {
        // ignore keepalives and partial frames
      }
    }
  }
}

export function applyMobileThreadEvent(
  prev: MobileSnapshot | null,
  event: ThreadEvent,
): MobileSnapshot | null {
  if (!prev || event.type === "heartbeat") return prev;
  if (stopsRunHelpers(event)) {
    const messages = settleRunSubagents(prev.messages, event.runId);
    if (messages !== prev.messages) prev = { ...prev, messages };
  }
  if (event.type === "thread.cleared") {
    return {
      ...prev,
      cursor: event.seq,
      messages: [],
      olderCursor: null,
      run: null,
      activeRuns: [],
    };
  }
  if (event.type === "run.started") {
    const cursor = event.seq ?? prev.cursor;
    // Match web: background ticket work stays out of the transcript.
    if (isBackgroundRunTrigger(event.payload?.trigger as string | undefined)) {
      return cursor === prev.cursor ? prev : { ...prev, cursor };
    }
    const members = prev.members?.map((member) =>
      member.botId === event.botId ? { ...member, status: "running" } : member,
    );
    if (!event.runId) return { ...prev, cursor, members };
    const previousRun =
      prev.activeRuns?.find((candidate) => candidate.id === event.runId) ??
      (prev.run?.id === event.runId ? prev.run : undefined);
    const run = {
      ...previousRun,
      id: event.runId,
      ...(event.botId ? { botId: event.botId } : {}),
      status: "running",
      error: null,
    };
    const activeRuns = [
      ...(prev.activeRuns ?? (prev.run ? [prev.run] : [])).filter(
        (candidate) => candidate.id !== run.id && isActive(candidate.status as RunStatus),
      ),
      run,
    ];
    return {
      ...prev,
      cursor,
      members,
      // Keep a group failure visible while another member starts work.
      run: prev.groupId && prev.run?.status === "failed" && prev.run.id !== run.id ? prev.run : run,
      activeRuns,
    };
  }
  if (event.type === "run.waiting_input" || event.type === "computer.takeover.requested") {
    const status = event.type === "run.waiting_input" ? "waiting_input" : "waiting_takeover";
    const progressId = progressMessageId(event);
    // Waiting pauses drop live progress server-side; clear a leftover bubble so
    // the waiting footer is not hidden behind a stale "Working…" row.
    const messages = prev.messages.filter((message) => message.id !== progressId);
    const progressCleared = messages.length !== prev.messages.length;
    const runId = event.runId;
    const knownInRun = Boolean(runId && prev.run?.id === runId);
    const knownInActive = Boolean(
      runId && prev.activeRuns?.some((candidate) => candidate.id === runId),
    );
    // Peer bot_message runs are omitted from snapshots while busy; the first wait
    // event is how an open thread learns they need ask/takeover UI.
    const needsInsert = Boolean(runId) && !knownInRun && !knownInActive;
    const runChanged = Boolean(knownInRun && prev.run && prev.run.status !== status);
    const activeRunChanged = Boolean(
      knownInActive &&
        prev.activeRuns?.some((candidate) => candidate.id === runId && candidate.status !== status),
    );
    const computer =
      event.type === "computer.takeover.requested" && prev.computer?.busyBotName
        ? { ...prev.computer, busyBotName: null }
        : prev.computer;
    const computerChanged = computer !== prev.computer;
    const cursor = event.seq ?? prev.cursor;
    if (!runChanged && !activeRunChanged && !progressCleared && !needsInsert && !computerChanged) {
      return cursor === prev.cursor ? prev : { ...prev, cursor };
    }
    if (needsInsert && runId) {
      const waitingRun = {
        id: runId,
        status,
        ...(event.botId ? { botId: event.botId } : {}),
      };
      const baseActive = prev.activeRuns ?? (prev.run ? [prev.run] : []);
      const activeRuns = [...baseActive.filter((candidate) => candidate.id !== runId), waitingRun];
      const promoteWaiting =
        !prev.run ||
        (prev.run.status !== "waiting_input" && prev.run.status !== "waiting_takeover");
      return {
        ...prev,
        cursor,
        messages,
        computer,
        run: promoteWaiting ? waitingRun : prev.run,
        activeRuns,
      };
    }
    const run = runChanged && prev.run ? { ...prev.run, status } : prev.run;
    const activeRuns = activeRunChanged
      ? prev.activeRuns?.map((candidate) =>
          candidate.id === runId ? { ...candidate, status } : candidate,
        )
      : prev.activeRuns;
    return { ...prev, cursor, run, activeRuns, messages, computer };
  }
  if (event.type === "computer.takeover.released") {
    const runId = event.runId;
    const settle = <T extends { id: string; status: string }>(candidate: T): T =>
      runId && candidate.id === runId && candidate.status === "waiting_takeover"
        ? { ...candidate, status: "queued" }
        : candidate;
    const nextRun = prev.run ? settle(prev.run) : prev.run;
    const activeChanged = Boolean(
      runId &&
        prev.activeRuns?.some(
          (candidate) => candidate.id === runId && candidate.status === "waiting_takeover",
        ),
    );
    const cursor = event.seq ?? prev.cursor;
    if (nextRun === prev.run && !activeChanged) {
      return cursor === prev.cursor ? prev : { ...prev, cursor };
    }
    const members = prev.members?.some(
      (member) => member.botId === event.botId && member.status === "waiting_takeover",
    )
      ? prev.members.map((member) =>
          member.botId === event.botId ? { ...member, status: "queued" } : member,
        )
      : prev.members;
    return {
      ...prev,
      cursor,
      run: nextRun,
      activeRuns: activeChanged ? prev.activeRuns?.map(settle) : prev.activeRuns,
      members,
    };
  }
  if (isRunTerminalEvent(event)) {
    const activeRuns = prev.activeRuns?.filter((candidate) => candidate.id !== event.runId);
    const failure = runFailureError(event);
    const primaryEnded = prev.run?.id === event.runId ? prev.run : null;
    // A group member run can fail while another is displayed; see reduceThreadSnapshot.
    const endedRun =
      primaryEnded ?? prev.activeRuns?.find((candidate) => candidate.id === event.runId) ?? null;
    return {
      ...prev,
      cursor: event.seq ?? prev.cursor,
      messages: prev.messages.filter((message) => message.id !== progressMessageId(event)),
      // A failed run stays in run so the thread can say why it stopped (see reduceThreadSnapshot).
      run:
        endedRun && failure
          ? { ...endedRun, status: "failed", error: failure }
          : primaryEnded
            ? (activeRuns?.[0] ?? null)
            : prev.run,
      activeRuns,
    };
  }
  if (event.type === "thread.progress") {
    const progressId = progressMessageId(event);
    const { previous, remaining } = takeLiveMessage(prev.messages, progressId);
    const streaming: MobileMessage = {
      id: progressId,
      role: "bot",
      blocks: reduceLiveMessageBlocks((previous?.blocks ?? []) as MessageBlock[], {
        type: "progress",
        payload: event.payload,
      }),
      ...(event.botId ? { botId: event.botId } : {}),
      ...(event.runId ? { runId: event.runId } : {}),
    };
    return {
      ...prev,
      cursor: event.seq ?? prev.cursor,
      messages: [...remaining, streaming],
    };
  }
  if (event.type === "agent.tool.called") {
    const progressId = progressMessageId(event);
    const { previous, remaining } = takeLiveMessage(prev.messages, progressId);
    const streaming: MobileMessage = {
      id: progressId,
      role: "bot",
      blocks: reduceLiveMessageBlocks((previous?.blocks ?? []) as MessageBlock[], {
        type: "tool",
        name: String(event.payload?.name ?? ""),
      }),
      ...(event.botId ? { botId: event.botId } : {}),
      ...(event.runId ? { runId: event.runId } : {}),
    };
    return {
      ...prev,
      cursor: event.seq ?? prev.cursor,
      messages: [...remaining, streaming],
    };
  }
  if (event.type === "agent.tool.completed") {
    return { ...prev, cursor: event.seq ?? prev.cursor };
  }
  if (event.type === "thread.subagent") {
    const agentId = String(event.payload?.agentId ?? event.id ?? "live");
    const status = event.payload?.status;
    const streaming: MobileMessage = {
      id: `subagent:${agentId}`,
      role: "bot",
      ...(event.botId ? { botId: event.botId } : {}),
      ...(event.runId ? { runId: event.runId } : {}),
      blocks: [
        {
          kind: "subagent",
          agentId,
          name: String(event.payload?.name ?? "subagent"),
          task: String(event.payload?.task ?? ""),
          status: status === "completed" || status === "failed" ? status : "running",
          progress: event.payload?.progress ? String(event.payload.progress) : undefined,
          result: event.payload?.result ? String(event.payload.result) : undefined,
        },
      ],
    };
    return {
      ...prev,
      cursor: event.seq ?? prev.cursor,
      messages: [...prev.messages.filter((message) => message.id !== streaming.id), streaming],
    };
  }
  if (event.type === "thread.cloud_agent") {
    return {
      ...prev,
      cursor: event.seq ?? prev.cursor,
      messages: updateCloudAgentMessages(prev.messages, event.payload ?? {}),
    };
  }
  if (event.type === "thread.message.created" || event.type === "thread.message.updated") {
    const { remaining } = takeLiveMessage(prev.messages, progressMessageId(event));
    const id = String(event.payload?.messageId ?? event.id ?? `msg:${event.seq ?? 0}`);
    const known = prev.messages.find((message) => message.id === id);
    const seq = typeof event.payload?.seq === "number" ? event.payload.seq : known?.seq;
    const next: MobileMessage = {
      id,
      // Inline cards act on the message's thread, so live messages need it too.
      threadId: known?.threadId ?? prev.threadId,
      // The seq lets a send that is still on screen as "Sending…" recognize its echo.
      ...(seq === undefined ? {} : { seq }),
      createdAt: known?.createdAt ?? event.createdAt,
      runId: event.runId ? String(event.runId) : undefined,
      role: (event.payload?.role as MobileMessage["role"]) ?? "bot",
      // An update can leave the call id out — the `end_call` marker does — so keep the one
      // the message already carries instead of dropping it out of its call.
      callId: typeof event.payload?.callId === "string" ? event.payload.callId : known?.callId,
      blocks: (event.payload?.blocks as MobileMessage["blocks"]) ?? [],
      botId: event.botId ?? (event.payload?.botId ? String(event.payload.botId) : undefined),
      ...replyMetadata(event.payload ?? {}, known),
    };
    return {
      ...prev,
      cursor: event.seq ?? prev.cursor,
      messages: upsertMessageById(
        remaining.filter(
          (message) =>
            !(
              message.id.startsWith("subagent:") &&
              next.blocks.some(
                (block) => block.kind === "subagent" && message.id === `subagent:${block.agentId}`,
              )
            ),
        ),
        next,
      ),
    };
  }
  return prev;
}

export {
  apiBaseWarning,
  defaultApiBase,
  displayApiHost,
  normalizeApiBase,
  probeApiBase,
  usesCustomApiBase,
} from "./endpoint";

import type { SecurityEventMetadata, SecurityEventType } from "@rakazo/contracts";
import { getLogContext, getLogger, redactBindings } from "@rakazo/logging";
import type { PrismaClient } from "./client.js";
import { parsePositiveInteger } from "./client.js";
import { runAsSystem } from "./row-security.js";

export type { SecurityEventType } from "@rakazo/contracts";

type SecurityEventDb = Pick<PrismaClient, "securityEvent">;

export interface SecurityEventInput {
  type: SecurityEventType;
  /** Defaults to the request's log context. */
  userId?: string | null;
  spaceId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  /** Identifiers, kinds, and outcomes. Content-like keys and non-scalar values are dropped. */
  metadata?: Record<string, string | number | boolean | null | undefined>;
}

/** Log-context keys a request middleware sets so every event and log line carries the caller. */
export function securityRequestBindings(request: { ip?: string; userAgent?: string }) {
  return {
    ...(request.ip ? { "client.ip": request.ip } : {}),
    ...(request.userAgent ? { "user_agent.original": request.userAgent } : {}),
  };
}

const FAILURE_TYPES = new Set<SecurityEventType>(["egress.refused"]);
const MAX_METADATA_KEYS = 16;
const MAX_METADATA_STRING = 200;
/** Keys that could carry what a user said or a secret. Never stored, whatever the value. */
const CONTENT_KEY =
  /content|message|prompt|body|text|answer|instruction|password|passwd|secret|token|cookie|authorization|credential|api_?key|code|email/i;

let store: SecurityEventDb | undefined;

/** Composition roots install the database once; until then events only reach the log. */
export function installSecurityEventStore(db: SecurityEventDb | undefined): void {
  store = db;
}

/**
 * Record one security event: a structured `security.event` log line for the log sink, plus an
 * append-only row. Never throws; a failed write is logged and the caller carries on.
 */
export async function recordSecurityEvent(input: SecurityEventInput): Promise<void> {
  const context = getLogContext();
  const event = {
    type: input.type,
    userId: bounded(input.userId ?? context["user.id"], 128),
    spaceId: bounded(input.spaceId ?? context["space.id"], 128),
    ip: bounded(input.ip ?? context["client.ip"], 64),
    userAgent: bounded(input.userAgent ?? context["user_agent.original"], 512),
    metadata: securityEventMetadata(input.metadata),
  };
  const level = FAILURE_TYPES.has(event.type) ? "warn" : "info";
  getLogger()[level]("security.event", {
    "security.event.type": event.type,
    "user.id": event.userId ?? undefined,
    "space.id": event.spaceId ?? undefined,
    "client.ip": event.ip ?? undefined,
    "user_agent.original": event.userAgent ?? undefined,
    "security.event.metadata": event.metadata,
  });
  if (!store) return;
  try {
    // An event may name another user or no Space at all, and must never be lost to
    // the caller's tenant; the table is only ever read as system.
    const db = store;
    await runAsSystem("append a security event", () => db.securityEvent.create({ data: event }));
  } catch (error) {
    getLogger().error("security.event.write_failed", error);
  }
}

export function securityEventMetadata(
  metadata: SecurityEventInput["metadata"] = {},
): SecurityEventMetadata {
  const kept: SecurityEventMetadata = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (Object.keys(kept).length >= MAX_METADATA_KEYS) break;
    if (CONTENT_KEY.test(key) || key.length > 64) continue;
    if (value === undefined) continue;
    if (typeof value === "string") kept[key] = value.slice(0, MAX_METADATA_STRING);
    else if (typeof value === "boolean" || value === null) kept[key] = value;
    else if (typeof value === "number" && Number.isFinite(value)) kept[key] = value;
  }
  // Values are identifiers, but an email or key pasted where an id belongs is still redacted.
  return redactBindings(kept) as SecurityEventMetadata;
}

function bounded(value: unknown, max: number): string | null {
  return typeof value === "string" && value ? value.slice(0, max) : null;
}

export const DEFAULT_SECURITY_EVENT_RETENTION_DAYS = 90;

export function securityEventRetentionDays(source: NodeJS.ProcessEnv = process.env): number {
  return parsePositiveInteger(
    source.SECURITY_EVENT_RETENTION_DAYS,
    DEFAULT_SECURITY_EVENT_RETENTION_DAYS,
  );
}

/** Delete events older than the retention window. Returns how many were removed. */
export async function pruneSecurityEvents(
  db: SecurityEventDb,
  retentionDays: number,
  now = new Date(),
): Promise<number> {
  const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);
  const { count } = await db.securityEvent.deleteMany({ where: { createdAt: { lt: cutoff } } });
  return count;
}

/** A pruner for a frequent reconciler tick that only touches the table about once an hour. */
export function createSecurityEventPruner(
  db: SecurityEventDb,
  retentionDays: number,
  options: { intervalMs?: number; now?: () => Date } = {},
): () => Promise<void> {
  const intervalMs = options.intervalMs ?? 60 * 60 * 1000;
  const now = options.now ?? (() => new Date());
  let lastRun: number | undefined;
  return async () => {
    const at = now();
    if (lastRun !== undefined && at.getTime() - lastRun < intervalMs) return;
    lastRun = at.getTime();
    const removed = await pruneSecurityEvents(db, retentionDays, at);
    if (removed > 0)
      getLogger().info("security.event.pruned", { "security.event.removed": removed });
  };
}

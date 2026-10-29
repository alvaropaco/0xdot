import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "./client.js";

export class IsolationError extends Error {
  constructor(message = "Resource not found") {
    super(message);
    this.name = "IsolationError";
  }
}

/** Unique (spaceId, userId, name) collision when renaming a bot section. */
export class BotSectionNameConflictError extends Error {
  constructor(message = "Resource name already used") {
    super(message);
    this.name = "BotSectionNameConflictError";
  }
}

/**
 * Resolve the actor for a request. There are no app accounts, so this always
 * resolves the deployment owner's membership; the requested-space header only
 * picks which of the owner's spaces to act in.
 */
export async function requireMembership(
  prisma: PrismaClient,
  userId: string,
  requestedSpaceId?: string | null,
): Promise<Actor> {
  const membership = await prisma.spaceMember.findFirst({
    where: {
      userId,
      ...(requestedSpaceId ? { spaceId: requestedSpaceId } : {}),
    },
    orderBy: [{ space: { isDefault: "desc" } }, { createdAt: "asc" }, { id: "asc" }],
    select: { userId: true, spaceId: true },
  });
  if (!membership) {
    throw new IsolationError("No personal space");
  }
  return { userId: membership.userId, spaceId: membership.spaceId };
}

export function scoped<T extends { spaceId: string; userId?: string }>(
  actor: Actor,
  record: T | null,
): T {
  if (!record || record.spaceId !== actor.spaceId) {
    throw new IsolationError();
  }
  if (record.userId && record.userId !== actor.userId) {
    throw new IsolationError();
  }
  return record;
}

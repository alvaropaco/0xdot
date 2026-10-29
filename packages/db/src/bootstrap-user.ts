import { randomBytes } from "node:crypto";
import type { PrismaClient } from "./client.js";

/**
 * Every deployment acts as this one user. It has no credentials and can never
 * sign in; it exists so per-user data columns, row-level security, and the
 * personal-space layout keep working unchanged.
 */
export const DEPLOYMENT_OWNER_EMAIL = "owner@localhost";
export const DEPLOYMENT_OWNER_NAME = "Owner";

function newId(): string {
  return randomBytes(16).toString("hex");
}

/** Prisma unique-constraint violation; anything else must still throw. */
function isUniqueViolation(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "P2002");
}

/** Provision a personal workspace. Signup never grants deployment administration. */
export async function bootstrapUserSpace(
  prisma: PrismaClient,
  user: { id: string },
): Promise<{ spaceId: string }> {
  // Concurrent bootstraps for the same user (e.g. overlapping first phone
  // inbounds) race on every unique key below; each step either wins or
  // joins the winner's state instead of failing.
  const slug = `user-${user.id.slice(0, 12)}`;
  let orgId = newId();
  try {
    await prisma.organization.create({
      data: { id: orgId, name: "Personal", slug, createdAt: new Date() },
    });
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    orgId = (await prisma.organization.findUniqueOrThrow({ where: { slug } })).id;
  }
  await prisma.member
    .create({
      data: {
        id: newId(),
        organizationId: orgId,
        userId: user.id,
        role: "owner",
        createdAt: new Date(),
      },
    })
    .catch((error: unknown) => {
      if (!isUniqueViolation(error)) throw error;
    });
  await prisma.space
    .create({
      data: {
        id: orgId,
        organizationId: orgId,
        name: "Personal",
        isDefault: true,
        createdByUserId: user.id,
        createdAt: new Date(),
      },
    })
    .catch((error: unknown) => {
      if (!isUniqueViolation(error)) throw error;
    });
  await prisma.spaceMember
    .create({
      data: {
        id: newId(),
        spaceId: orgId,
        organizationId: orgId,
        userId: user.id,
        role: "owner",
        createdAt: new Date(),
      },
    })
    .catch((error: unknown) => {
      if (!isUniqueViolation(error)) throw error;
    });
  const hasMemory = await prisma.memoryDocument.findFirst({
    where: { spaceId: orgId, userId: user.id, scope: "user", path: "MEMORY.md" },
  });
  if (!hasMemory) {
    await prisma.memoryDocument
      .create({
        data: {
          spaceId: orgId,
          userId: user.id,
          scope: "user",
          path: "MEMORY.md",
          content: "# Space memory\n\nPreferences and context kept within this space live here.\n",
        },
      })
      .catch((error: unknown) => {
        if (!isUniqueViolation(error)) throw error;
      });
  }
  await prisma.notificationPreference
    .create({
      data: {
        spaceId: orgId,
        userId: user.id,
      },
    })
    .catch((error: unknown) => {
      if (!isUniqueViolation(error)) throw error;
    });
  return { spaceId: orgId };
}

/**
 * Find or create the deployment's single owner and its personal space.
 * Idempotent: safe to call on every startup and from overlapping boot paths.
 */
export async function ensureDeploymentOwner(
  prisma: PrismaClient,
): Promise<{ userId: string; spaceId: string }> {
  const existing = await prisma.user.findFirst({
    where: { email: DEPLOYMENT_OWNER_EMAIL },
    select: { id: true },
  });
  const user =
    existing ??
    (await prisma.user.create({
      data: {
        id: newId(),
        name: DEPLOYMENT_OWNER_NAME,
        email: DEPLOYMENT_OWNER_EMAIL,
        createdAt: new Date(),
      },
      select: { id: true },
    }));
  const { spaceId } = await bootstrapUserSpace(prisma, user);
  return { userId: user.id, spaceId };
}

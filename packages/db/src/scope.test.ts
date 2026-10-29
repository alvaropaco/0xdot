import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "./client.js";
import { IsolationError, requireMembership } from "./scope.js";

function prismaForMembership(found: boolean) {
  return {
    spaceMember: {
      findFirst: vi.fn(async ({ where }: { where: { userId: string; spaceId?: string } }) =>
        found ? { userId: where.userId, spaceId: where.spaceId ?? "space-default" } : null,
      ),
    },
  } as unknown as PrismaClient;
}

describe("requireMembership", () => {
  it("resolves the actor from the owner's membership", async () => {
    const prisma = prismaForMembership(true);

    await expect(requireMembership(prisma, "user-1", "space-support")).resolves.toEqual({
      userId: "user-1",
      spaceId: "space-support",
    });
    expect(prisma.spaceMember.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: "user-1", spaceId: "space-support" },
      }),
    );
  });

  it("rejects a requested space the user does not belong to", async () => {
    await expect(
      requireMembership(prismaForMembership(false), "user-1", "space-foreign"),
    ).rejects.toBeInstanceOf(IsolationError);
  });

  it("selects the explicit default Space before older non-default memberships", async () => {
    const prisma = prismaForMembership(true);

    await requireMembership(prisma, "user-1");

    expect(prisma.spaceMember.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: [{ space: { isDefault: "desc" } }, { createdAt: "asc" }, { id: "asc" }],
      }),
    );
  });
});

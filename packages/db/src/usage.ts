import type { AgentRuntimeEvent, UsageOperationKind } from "@rakazo/adapter-kit";
import type { PrismaClient } from "./generated/prisma/client.js";

type UsageEvent = Extract<AgentRuntimeEvent, { type: "usage" }>;
export interface UsageAttribution {
  spaceId: string;
  userId: string;
  botId?: string;
  runId?: string;
  parentRunId?: string;
  operationId?: string;
  operationKind?: UsageOperationKind;
}

/** Usage is independent from message clearing or bot deletion. */
export async function recordUsage(
  prisma: Pick<PrismaClient, "$transaction">,
  event: UsageEvent,
  attribution: UsageAttribution,
) {
  const data = {
    provider: event.provider,
    model: event.model,
    spaceId: attribution.spaceId,
    userId: attribution.userId,
    botId: attribution.botId,
    runId: attribution.runId,
    operationId: attribution.operationId,
    parentRunId: attribution.parentRunId ?? attribution.runId,
    providerRequestId: event.providerRequestId ?? null,
    inputTokens: event.inputTokens,
    outputTokens: event.outputTokens,
    cacheReadTokens: event.cacheReadTokens ?? null,
    cacheWriteTokens: event.cacheWriteTokens ?? null,
    cacheWrite1hTokens: event.cacheWrite1hTokens ?? null,
    reasoningTokens: event.reasoningTokens ?? null,
    totalTokens: event.totalTokens ?? null,
    costUsd: event.costUsd ?? null,
    costSource: event.costSource ?? null,
    pricingVersion: event.pricingVersion ?? null,
    pricingSnapshot: event.pricingSnapshot
      ? JSON.parse(JSON.stringify(event.pricingSnapshot))
      : undefined,
    usageSource: event.usageSource ?? null,
    callId: event.callId ?? null,
    operationKind: attribution.operationKind ?? event.operationKind ?? "answer",
    agentId: event.agentId ?? null,
  };
  await prisma.$transaction(async (tx) => {
    await tx.usageRecord.createMany({ data: [data], skipDuplicates: true });
  });
}

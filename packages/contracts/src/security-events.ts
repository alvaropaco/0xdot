import * as z from "zod";

/** Every security event the backend records. Alert queries match these strings. */
export const SECURITY_EVENT_TYPES = [
  "credential.created",
  "credential.changed",
  "credential.deleted",
  "approval.decided",
  "approval.policy.changed",
  "egress.refused",
] as const;

export const SecurityEventTypeSchema = z.enum(SECURITY_EVENT_TYPES);
export type SecurityEventType = z.infer<typeof SecurityEventTypeSchema>;

/** Small, flat, and content-free: identifiers, kinds, and outcomes only. */
export const SecurityEventMetadataSchema = z.record(
  z.string(),
  z.union([z.string(), z.number(), z.boolean(), z.null()]),
);
export type SecurityEventMetadata = z.infer<typeof SecurityEventMetadataSchema>;

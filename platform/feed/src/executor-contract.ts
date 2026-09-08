import { z } from "zod";

const integer = z.number().int().safe(),
  id = z.string().min(1).max(160),
  repo = z.string().regex(/^[a-z0-9][a-z0-9_.-]{0,99}\/[a-z0-9_.-]{1,100}$/),
  time = z.iso.datetime({ offset: true });
const digest = z.string().regex(/^[a-f0-9]{64}$/),
  strings = z
    .array(z.string().max(500))
    .max(100)
    .nullable()
    .transform((v) => v ?? []);
export const sourceEvent = z.strictObject({
  contractVersion: z.literal(1),
  eventId: id,
  aggregateKey: repo,
  sourceVersion: integer.positive(),
  kind: z.literal("assessment.completed"),
  analysisId: id,
  receiptId: id,
  sourceHash: digest,
  occurredAt: integer.positive(),
});
const finish = z.strictObject({
  writerEpoch: integer.positive(),
  eventId: id,
  leaseOwner: id,
  errorCode: z
    .string()
    .regex(/^[a-z][a-z0-9_]{0,63}$/)
    .optional(),
});
const projection = z.strictObject({
  repoKey: repo,
  itemId: id,
  ownerLogin: id,
  name: id,
  canonicalUrl: z.url().max(500),
  summary: z.string().max(16000),
  painStatement: z.string().max(16000),
  targetUsers: strings,
  language: z.string().max(100).nullable(),
  topics: strings,
  projectType: id,
  lifecycle: id,
  productScore: z.number().min(0).max(100),
  confidence: z.number().min(0).max(100),
  verificationLevel: id,
  exposureBand: id,
  treasureEligible: z.boolean(),
  classicEligible: z.boolean(),
  risks: z
    .array(
      z.strictObject({
        severity: z.enum(["low", "medium", "high"]),
        category: id,
        summary: z.string().max(4000),
        evidence_ids: strings,
      }),
    )
    .max(50)
    .nullable()
    .transform((v) => v ?? []),
  analysisId: id,
  resolvedCommitSha: z.string().regex(/^[a-f0-9]{40}$/),
  analyzedAt: time,
  descriptor: z.string().max(32000),
  descriptorHash: digest,
  sourceHash: digest,
  publishable: z.boolean(),
  blockedReason: z.string().max(2000),
  riskOverrideEligible: z.boolean(),
  productTags: z
    .array(
      z.strictObject({
        namespace: z.string().max(30),
        namespaceExplicit: z.boolean(),
        slug: id,
        labels: z.strictObject({
          zh: z.string().max(300),
          en: z.string().max(300),
        }),
        evidenceIds: strings,
      }),
    )
    .max(100)
    .nullable()
    .transform((v) => v ?? []),
});
export const executorSchemas = {
  "jobs.claim": z.strictObject({
    writerEpoch: integer.positive(),
    event: sourceEvent,
    leaseOwner: id,
    leaseSeconds: z.literal(90),
  }),
  "jobs.complete": finish,
  "jobs.fail": finish,
  "projection.apply": z.strictObject({
    writerEpoch: integer.positive(),
    eventId: id,
    leaseOwner: id,
    sourceVersion: integer.positive(),
    projection,
    receipt: z.strictObject({
      receiptId: id,
      sourceKind: z.enum([
        "app_submission",
        "agent_submission",
        "verified_backfill",
      ]),
      submittedAt: time,
    }),
  }),
};
export type ExecutorOperation = keyof typeof executorSchemas;
export type ExecutorInput<K extends ExecutorOperation> = z.infer<
  (typeof executorSchemas)[K]
>;

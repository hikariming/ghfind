import { z } from "zod";

const integer = z.number().int().safe();
const id = z.string().min(1).max(160);
const repo = z
  .string()
  .regex(/^[a-z0-9][a-z0-9_.-]{0,99}\/[a-z0-9_.-]{1,100}$/);
const time = z.iso.datetime({ offset: true });
const finite = z.number().finite();
const unit = finite.min(0).max(1);
const strings = z.array(z.string().max(160)).max(30);
const fence = {
  writerEpoch: integer.positive(),
  expectedProfileVersion: integer.nonnegative(),
};
const actor = { githubId: integer.positive() };
export const preference = z.strictObject({
  tagId: id,
  value: z.union([z.literal(-1), z.literal(1)]),
  source: z.enum(["explicit", "graph", "behavior"]),
  strength: unit,
  taxonomyVersion: integer.positive(),
});
const tag = z.strictObject({
  id,
  namespace: z.enum([
    "domain",
    "use_case",
    "audience",
    "artifact",
    "stack",
    "stage",
  ]),
  slug: id,
  labelZh: z.string().max(300),
  labelEn: z.string().max(300),
  description: z.string().max(2000).optional(),
  weight: unit.optional(),
  confidence: unit.optional(),
  taxonomyVersion: integer.positive(),
});
const project = z.strictObject({
  repoKey: repo,
  itemId: id,
  ownerLogin: id,
  name: id,
  canonicalUrl: z.url().max(500),
  summary: z.string().max(16000),
  language: z.string().max(100).nullable(),
  topics: strings.nullable().transform((v) => v ?? []),
  projectType: id,
  lifecycle: id,
  productScore: finite.min(0).max(100),
  confidence: finite.min(0).max(100),
  verificationLevel: id,
  exposureBand: id,
  treasureEligible: z.boolean(),
  classicEligible: z.boolean(),
  analyzedAt: time,
  publishable: z.boolean(),
  submissionEvidence: z.boolean(),
  tags: z.array(tag).max(100),
});
export const user = z.strictObject({
  ...actor,
  login: id,
  avatarUrl: z.string().max(500).optional(),
  taxonomyVersion: integer.positive(),
  profileVersion: integer.positive(),
  profileFloor: integer.nonnegative(),
  preferences: z.array(preference).max(300),
  embedding: z.array(finite).max(4096).optional(),
  embeddingModel: id.optional(),
  embeddingDimensions: integer.positive().max(4096).optional(),
});
const features = z.strictObject({
  tagAffinity: finite.optional(),
  semanticSimilarity: finite.optional(),
  productScore: finite,
  confidence: finite,
  freshness: finite,
  discoveryBoost: finite,
  mmrScore: finite,
});
const item = z.strictObject({
  project,
  candidateSources: strings.min(1),
  reasonCodes: strings,
  score: finite,
  rank: integer.min(0).max(239),
  exploration: z.boolean(),
  propensity: finite.gt(0).max(1),
  features,
});
const counts = z.partialRecord(
  z.enum(["tag", "latest", "quality", "longTail", "discovery", "semantic"]),
  integer.nonnegative().max(240),
);
const session = z.strictObject({
  id,
  ...actor,
  algorithmVersion: id,
  taxonomyVersion: integer.positive(),
  profileVersion: integer.positive(),
  pageSize: integer.positive().max(50),
  seed: id,
  candidateCounts: counts,
  degraded: strings.nullable().transform((v) => v ?? []),
  items: z.array(item).max(240),
  createdAt: time,
  expiresAt: time,
});
const event = z.strictObject({
  input: z.strictObject({
    id,
    type: z.enum([
      "impression",
      "detail_open",
      "dwell",
      "github_outbound",
      "share",
    ]),
    repoKey: repo,
    occurredAt: time,
    impressionToken: z.string().min(1).max(3000),
    durationMs: integer.nonnegative().max(3600000).optional(),
  }),
  requestId: id,
  metadata: z.strictObject({
    rank: integer.min(0).max(239),
    algorithmVersion: id,
    durationMs: integer.nonnegative().max(3600000).optional(),
    qualified: z.boolean().optional(),
  }),
});
export const schemas = {
  health: z.strictObject({}),
  "taxonomy.list": z.strictObject({}),
  "taxonomy.propose": z
    .strictObject({
      ...fence,
      ...actor,
      id: z.uuid(),
      repoKey: repo,
      namespace: z.enum([
        "domain",
        "use_case",
        "audience",
        "artifact",
        "stack",
        "stage",
      ]),
      slug: z
        .string()
        .max(80)
        .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
      labelZh: z
        .string()
        .refine((v) => new TextEncoder().encode(v).length <= 160),
      labelEn: z
        .string()
        .refine((v) => new TextEncoder().encode(v).length <= 160),
      evidence: z
        .array(
          z
            .string()
            .refine(
              (v) =>
                v.trim().length > 0 &&
                new TextEncoder().encode(v).length <= 256,
            ),
        )
        .min(1)
        .max(16),
    })
    .refine((v) => v.labelZh.trim().length > 0 || v.labelEn.trim().length > 0),
  "users.ensure": z.strictObject({
    ...fence,
    ...actor,
    login: id,
    avatarUrl: z.string().max(500),
  }),
  "users.get": z.strictObject(actor),
  "preferences.replace": z.strictObject({
    ...fence,
    ...actor,
    taxonomyVersion: integer.positive(),
    preferences: z.array(preference).max(30),
  }),
  "candidates.load": z.strictObject({
    ...actor,
    limit: integer.positive().max(240),
  }),
  "projects.available": z.strictObject({
    ...actor,
    repoKeys: z.array(repo).max(240),
  }),
  "requests.save": z.strictObject({
    ...fence,
    payloadHash: z.string().regex(/^[a-f0-9]{64}$/),
    id,
    user,
    seed: id,
    candidateCounts: counts,
    degraded: strings.nullable().transform((v) => v ?? []),
    durationMs: integer.nonnegative().max(300000),
    items: z.array(item).max(50),
  }),
  "state.set": z
    .strictObject({
      ...fence,
      ...actor,
      repoKey: repo,
      requestId: id,
      saved: z.boolean().optional(),
      notInterested: z.boolean().optional(),
      now: time,
    })
    .refine((v) => (v.saved === undefined) !== (v.notInterested === undefined)),
  "events.append": z.strictObject({
    ...fence,
    ...actor,
    events: z.array(event).max(50),
  }),
  "profile.delete": z.strictObject({ ...fence, ...actor, now: time }),
  "profile.deletion.get": z.strictObject({ ...actor, deletionId: id }),
  "sessions.put": z.strictObject({ ...fence, session }),
  "sessions.get": z.strictObject({ ...fence, ...actor, id }),
  "sessions.delete": z.strictObject({ ...fence, ...actor, id }),
} as const;
export type Operation = keyof typeof schemas;
export type Input<K extends Operation> = z.infer<(typeof schemas)[K]>;
export type User = z.infer<typeof user>;
export type Project = z.infer<typeof project>;
export type Fence = { writerEpoch: number; expectedProfileVersion: number };

export class BridgeError extends Error {
  constructor(
    public status: number,
    public code: string,
  ) {
    super(code);
  }
}
export function badRequest(): never {
  throw new BridgeError(400, "invalid_request");
}
export async function hash(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}

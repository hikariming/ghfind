/** GitHub issues and PRs share each repository's number namespace (#370).
 * Display order must not follow mutable consumer completion timestamps.
 * Apply this order in SQL before LIMIT/OFFSET, after repository grouping.
 */
const itemOrder = (prefix: "" | "j.") =>
  `CASE WHEN ${prefix}pr>0 THEN 0 ELSE 1 END ASC,` +
  `CASE WHEN ${prefix}pr>0 THEN ${prefix}pr END ASC,` +
  `${prefix}created ASC,${prefix}id COLLATE BINARY ASC`;

// Fixed fragments only; callers never interpolate user-provided identifiers.
export const JOB_ITEM_ORDER_SQL = itemOrder("");
export const JOINED_JOB_ITEM_ORDER_SQL = itemOrder("j.");

export interface DisplayJob {
  repository: number | null;
  fullName?: string | null;
  full_name?: string | null;
  pr: number | null;
  created: number;
  id: string;
}

const encoder = new TextEncoder();
/** Match SQLite BINARY ordering, including non-ASCII identifiers. */
function binaryCompare(a: string, b: string): number {
  if (a === b) return 0;
  const first = encoder.encode(a), second = encoder.encode(b);
  for (let i = 0; i < Math.min(first.length, second.length); i++) {
    if (first[i] !== second[i]) return first[i] - second[i];
  }
  return first.length - second.length;
}
// SQLite lower() folds ASCII letters. GitHub repository names validated by
// repositoryName() are ASCII; retain matching behavior for unknown legacy text.
const canonicalName = (job: DisplayJob) => (job.fullName ?? job.full_name ?? "")
  .replace(/[A-Z]/g, character => character.toLowerCase());

/** Merge already-authorized repository batches in the same order as SQL:
 * canonical repository name, repository ID, shared GitHub # ascending, immutable
 * admission time and ID. Repository-less discovery comes last; non-item tasks
 * come after numbered items within a repository. No row is removed or mutated.
 */
export function compareJobsByItem(a: DisplayJob, b: DisplayJob): number {
  const repositoryOrder = Number(a.repository === null) - Number(b.repository === null)
    || binaryCompare(canonicalName(a), canonicalName(b))
    || (a.repository ?? 0) - (b.repository ?? 0);
  if (repositoryOrder) return repositoryOrder;
  const aNumbered = a.pr !== null && a.pr > 0, bNumbered = b.pr !== null && b.pr > 0;
  return Number(bNumbered) - Number(aNumbered)
    || (aNumbered && bNumbered ? a.pr! - b.pr! : 0)
    || a.created - b.created
    || binaryCompare(a.id, b.id);
}

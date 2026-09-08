export type CatalogRow = Record<string, string | number | null>;

// This bounded probe selects a query plan only. Neither its rows nor its limit
// form a candidate set: both plans apply every hard filter before LIMIT 80.
const SPARSE_TAG_MEMBERSHIPS = 512;

export async function recallTags(
  db: D1Database,
  eligibility: string,
  githubId: number,
  positiveTags: string[],
): Promise<CatalogRow[]> {
  if (!positiveTags.length) return [];
  const positive = JSON.stringify(positiveTags);
  const probe = await db
    .prepare(
      `SELECT COUNT(*) AS memberships FROM (
        SELECT 1 FROM feed_project_tags
        WHERE tag_id IN (SELECT value FROM json_each(?)) LIMIT ${SPARSE_TAG_MEMBERSHIPS}
      )`,
    )
    .bind(positive)
    .all<{ memberships: number }>();
  const sparse = probe.results[0].memberships < SPARSE_TAG_MEMBERSHIPS;

  // The ordered catalog plan is cheap for common tags, but scans the entire
  // published catalog for rare tags. Materializing the complete sparse tag set
  // and fixing join order uses tag_id and project PK indexes before the sort.
  // Multiple matching tags are deduplicated before joining projects.
  const statement = sparse
    ? db
        .prepare(
          `WITH matching AS MATERIALIZED (
            SELECT DISTINCT repo_key,analysis_id FROM feed_project_tags
            WHERE tag_id IN (SELECT value FROM json_each(?))
          )
          SELECT p.* FROM matching CROSS JOIN feed_projects p ON p.repo_key=matching.repo_key AND p.analysis_id=matching.analysis_id
          WHERE ${eligibility}
          ORDER BY p.product_score DESC,p.analyzed_at DESC,p.repo_key LIMIT 80`,
        )
        .bind(positive, githubId, githubId)
    : db
        .prepare(
          `SELECT p.* FROM feed_projects p WHERE ${eligibility}
          AND EXISTS(SELECT 1 FROM feed_project_tags pt WHERE pt.repo_key=p.repo_key AND pt.analysis_id=p.analysis_id AND pt.tag_id IN(SELECT value FROM json_each(?)))
          ORDER BY p.product_score DESC,p.analyzed_at DESC,p.repo_key LIMIT 80`,
        )
        .bind(githubId, githubId, positive);
  return (await statement.all<CatalogRow>()).results;
}

// The transport compatibility window is necessary but cannot prove that this
// binary's capabilities have their required tables and columns. In particular,
// the runtime control value intentionally stays 7 across additive migrations.
// These are fixed, read-only schema probes; no runtime migration or SQL RPC.
export async function hasFeedRuntimeSchema(db: D1Database): Promise<boolean> {
  const results = await db.batch<{ count: number }>([
    db.prepare(
      "SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name IN ('feed_runtime_sessions','feed_runtime_requests','feed_runtime_events','feed_execution_jobs','feed_project_source_versions','feed_user_tag_proposals','feed_replay_deliveries','feed_delivery_heads','feed_delivery_terminals','feed_governance_commands','feed_governance_guards','feed_user_proposal_authors','feed_tag_proposal_commands','feed_adapter_write_fence','feed_adapter_write_context')",
    ),
    db.prepare(
      "SELECT COUNT(*) AS count FROM pragma_table_info('feed_project_tags') WHERE name='origin_proposal_id'",
    ),
    db.prepare(
      "SELECT COUNT(*) AS count FROM pragma_table_info('feed_governance_guards') WHERE name='author_ok'",
    ),
    db.prepare(
      "SELECT COUNT(*) AS count FROM sqlite_master WHERE type='trigger' AND (name LIKE 'feed_%_adapter_insert' OR name LIKE 'feed_%_adapter_update' OR name LIKE 'feed_%_adapter_delete')",
    ),
  ]);
  return [15, 1, 1, 39].every(
    (count, index) =>
      results[index].success && results[index].results[0]?.count === count,
  );
}

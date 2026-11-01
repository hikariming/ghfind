// Settings changes and operations, from the web admin or the API. Details
// hold settings, counts and ids only: never issue text, tokens or emails.
export async function audit(
  env: Env,
  repository: number,
  actor: string,
  via: "web" | "api",
  action: string,
  detail: Record<string, unknown> = {},
) {
  await env.DB.prepare(
    "INSERT INTO audit_log(repository,actor,via,action,detail,created) VALUES(?,?,?,?,?,?)",
  )
    .bind(repository, actor, via, action, JSON.stringify(detail), Date.now())
    .run();
}
export async function recentAudit(env: Env, repository: number, limit = 20) {
  const { results } = await env.DB.prepare(
    "SELECT actor,via,action,detail,created FROM audit_log WHERE repository=? ORDER BY id DESC LIMIT ?",
  )
    .bind(repository, limit)
    .all<{
      actor: string;
      via: string;
      action: string;
      detail: string;
      created: number;
    }>();
  return results.map((x) => ({
    actor: x.actor,
    via: x.via,
    action: x.action,
    detail: JSON.parse(x.detail) as unknown,
    at: new Date(x.created).toISOString(),
  }));
}

import { BridgeError, type Fence, type Input, type User } from "./contract";
import { recallTags, type CatalogRow } from "./catalog";

type Value = string | number | null;
type Row = CatalogRow;
export class FeedStore {
  constructor(readonly db: D1Database) {}
  sql(query: string, ...values: Value[]) {
    return this.db.prepare(query).bind(...values);
  }
  async rows<T = Row>(query: string, ...values: Value[]): Promise<T[]> {
    return (await this.sql(query, ...values).all<T>()).results;
  }
  async batch(statements: D1PreparedStatement[]) {
    try {
      return await this.db.batch(statements);
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      for (const code of [
        "writer_epoch_changed",
        "profile_version_changed",
        "taxonomy_version_changed",
        "project_not_found",
        "idempotency_conflict",
        "source_identity_mismatch",
        "job_lease_lost",
        "proposal_id_conflict",
        "archive_id_conflict",
        "replay_not_allowed",
        "delivery_identity_mismatch",
      ]) {
        if (message.includes(code))
          throw new BridgeError(code === "project_not_found" ? 404 : 409, code);
      }
      throw error;
    }
  }
  // Each command's first statement asserts the epoch and profile INSIDE the
  // same transaction as its writes, so a successful preflight cannot race a fence.
  guard(
    command: string,
    fence: Fence,
    githubId: number,
    options: {
      allowAbsent?: boolean;
      ensure?: boolean;
      taxonomy?: number;
      taxonomyRequestIds?: string[];
      relation?: string;
      relationValues?: Value[];
      payload?: string;
      payloadValues?: Value[];
    } = {},
  ) {
    const profile = options.ensure
      ? "1"
      : options.allowAbsent
        ? "CASE WHEN COALESCE((SELECT profile_version FROM feed_users WHERE github_id=?),0)=? THEN 1 ELSE 0 END"
        : "CASE WHEN EXISTS(SELECT 1 FROM feed_users WHERE github_id=? AND profile_version=?) THEN 1 ELSE 0 END";
    const taxonomy =
      options.taxonomy !== undefined
        ? "CASE WHEN (SELECT version FROM feed_taxonomy_versions WHERE status='active')=? THEN 1 ELSE 0 END"
        : options.taxonomyRequestIds !== undefined
          ? "CASE WHEN EXISTS(SELECT 1 FROM feed_taxonomy_versions WHERE status='active') AND NOT EXISTS(SELECT 1 FROM feed_runtime_requests WHERE github_id=? AND id IN(SELECT value FROM json_each(?)) AND taxonomy_version<>(SELECT version FROM feed_taxonomy_versions WHERE status='active')) THEN 1 ELSE 0 END"
          : "1";
    return this.sql(
      `INSERT INTO feed_command_guards(id,writer_ok,profile_ok,taxonomy_ok,relation_ok,payload_ok)
      VALUES (?,CASE WHEN EXISTS(SELECT 1 FROM feed_runtime_control WHERE id=1 AND writer_epoch=? AND writes_enabled=1) THEN 1 ELSE 0 END,
      ${profile},${taxonomy},${options.relation ?? "1"},${options.payload ?? "1"})`,
      command,
      fence.writerEpoch,
      ...(options.ensure ? [] : [githubId, fence.expectedProfileVersion]),
      ...(options.taxonomy !== undefined
        ? [options.taxonomy]
        : options.taxonomyRequestIds !== undefined
          ? [githubId, JSON.stringify(options.taxonomyRequestIds)]
          : []),
      ...(options.relationValues ?? []),
      ...(options.payloadValues ?? []),
    );
  }
  end(command: string) {
    return this.sql("DELETE FROM feed_command_guards WHERE id=?", command);
  }
  outbox(
    command: string,
    topic: string,
    githubId: number,
    payload: object,
    now: number,
  ) {
    return this.sql(
      `INSERT INTO feed_runtime_outbox(id,topic,aggregate_key,profile_version,payload_json,available_at,created_at)
      VALUES (?,?,?,(SELECT profile_version FROM feed_users WHERE github_id=?),?,?,?) ON CONFLICT(id) DO NOTHING`,
      command,
      topic,
      `gh:${githubId}`,
      githubId,
      JSON.stringify(payload),
      now,
      now,
    );
  }
  async taxonomy() {
    const versions = await this.rows<{ version: number }>(
      "SELECT version FROM feed_taxonomy_versions WHERE status='active'",
    );
    if (versions.length !== 1) throw new BridgeError(503, "feed_unavailable");
    const tags = await this.rows(
      "SELECT id,namespace,slug,label_zh AS labelZh,label_en AS labelEn,description,taxonomy_version AS taxonomyVersion FROM feed_tag_definitions WHERE status='canonical' AND taxonomy_version<=? ORDER BY namespace,slug",
      versions[0].version,
    );
    return { tags, taxonomyVersion: versions[0].version };
  }
  async user(githubId: number): Promise<User | null> {
    const users = await this.rows<Omit<User, "preferences">>(
      "SELECT github_id AS githubId,login,COALESCE(avatar_url,'') AS avatarUrl,(SELECT version FROM feed_taxonomy_versions WHERE status='active') AS taxonomyVersion,profile_version AS profileVersion,COALESCE((SELECT profile_floor FROM feed_profile_floors f WHERE f.github_id=feed_users.github_id),0) AS profileFloor FROM feed_users WHERE github_id=?",
      githubId,
    );
    if (!users.length) return null;
    if (!users[0].taxonomyVersion)
      throw new BridgeError(503, "feed_unavailable");
    const preferences = await this.rows<User["preferences"][number]>(
      `SELECT p.tag_id AS tagId,p.value,p.source,p.strength,p.taxonomy_version AS taxonomyVersion
      FROM feed_user_tag_preferences p JOIN feed_tag_definitions t ON t.id=p.tag_id AND t.status='canonical'
      WHERE p.github_id=? AND t.taxonomy_version<=(SELECT version FROM feed_taxonomy_versions WHERE status='active') AND NOT EXISTS(SELECT 1 FROM feed_user_tag_preferences x WHERE x.github_id=p.github_id AND x.tag_id=p.tag_id
        AND CASE x.source WHEN 'explicit' THEN 3 WHEN 'behavior' THEN 2 ELSE 1 END > CASE p.source WHEN 'explicit' THEN 3 WHEN 'behavior' THEN 2 ELSE 1 END)
      ORDER BY p.tag_id LIMIT 300`,
      githubId,
    );
    return { ...users[0], preferences };
  }
  async ensure(input: Input<"users.ensure">) {
    const command = crypto.randomUUID(),
      now = Date.now();
    await this.batch([
      this.guard(command, input, input.githubId, { ensure: true }),
      this.sql(
        `INSERT INTO feed_users(github_id,login,avatar_url,profile_version,taxonomy_version,created_at,updated_at)
        VALUES(?,?,?,COALESCE((SELECT profile_floor+1 FROM feed_profile_floors WHERE github_id=?),1),(SELECT version FROM feed_taxonomy_versions WHERE status='active'),?,?)
        ON CONFLICT(github_id) DO UPDATE SET login=excluded.login,avatar_url=excluded.avatar_url,updated_at=excluded.updated_at`,
        input.githubId,
        input.login,
        input.avatarUrl,
        input.githubId,
        now,
        now,
      ),
      this.end(command),
    ]);
    return { user: await this.user(input.githubId) };
  }
  async preferences(input: Input<"preferences.replace">) {
    const command = crypto.randomUUID(),
      now = Date.now();
    if (
      new Set(input.preferences.map((p) => p.tagId)).size !==
        input.preferences.length ||
      input.preferences.some(
        (p) =>
          p.source !== "explicit" ||
          p.strength !== 1 ||
          p.taxonomyVersion !== input.taxonomyVersion,
      )
    )
      throw new BridgeError(400, "invalid_request");
    const ids = JSON.stringify(input.preferences.map((p) => p.tagId));
    await this.batch([
      this.guard(command, input, input.githubId, {
        taxonomy: input.taxonomyVersion,
        relation:
          "CASE WHEN (SELECT COUNT(*) FROM feed_tag_definitions WHERE id IN (SELECT value FROM json_each(?)) AND status='canonical' AND taxonomy_version<=?)=? THEN 1 ELSE 0 END",
        relationValues: [ids, input.taxonomyVersion, input.preferences.length],
      }),
      this.sql(
        "DELETE FROM feed_user_tag_preferences WHERE github_id=? AND source='explicit'",
        input.githubId,
      ),
      this.sql(
        `INSERT INTO feed_user_tag_preferences(github_id,tag_id,value,source,strength,taxonomy_version,updated_at)
        SELECT ?,json_extract(value,'$.tagId'),json_extract(value,'$.value'),'explicit',1,?,? FROM json_each(?)`,
        input.githubId,
        input.taxonomyVersion,
        now,
        JSON.stringify(input.preferences),
      ),
      this.sql(
        "UPDATE feed_users SET profile_version=profile_version+1,taxonomy_version=?,updated_at=? WHERE github_id=?",
        input.taxonomyVersion,
        now,
        input.githubId,
      ),
      this.outbox(
        command,
        "feed.profile-rebuild.v1",
        input.githubId,
        { githubId: input.githubId },
        now,
      ),
      this.end(command),
    ]);
    return { user: await this.user(input.githubId) };
  }
  eligible(alias = "p") {
    return `${alias}.published=1 AND (EXISTS(SELECT 1 FROM feed_submission_provenance v WHERE v.repo_key=${alias}.repo_key AND v.analysis_id=${alias}.analysis_id AND v.revoked_at IS NULL)
      OR EXISTS(SELECT 1 FROM feed_project_source_versions v WHERE v.repo_key=${alias}.repo_key AND v.analysis_id=${alias}.analysis_id AND v.revoked_at IS NULL))
      AND NOT EXISTS(SELECT 1 FROM feed_project_moderation m WHERE m.repo_key=${alias}.repo_key AND m.removed=1)
      AND NOT EXISTS(SELECT 1 FROM feed_user_project_states s WHERE s.github_id=? AND s.repo_key=${alias}.repo_key AND s.not_interested=1)
      AND NOT EXISTS(SELECT 1 FROM feed_project_tags t JOIN feed_tag_definitions d ON d.id=t.tag_id AND d.status='canonical' AND d.taxonomy_version<=(SELECT version FROM feed_taxonomy_versions WHERE status='active') JOIN feed_user_tag_preferences u ON u.tag_id=t.tag_id AND u.github_id=? AND u.source='explicit' AND u.value=-1 WHERE t.repo_key=${alias}.repo_key)`;
  }
  async available(input: Input<"projects.available">) {
    const rows = await this.rows<{ repo_key: string }>(
      `SELECT p.repo_key FROM feed_projects p WHERE ${this.eligible()} AND p.repo_key IN(SELECT value FROM json_each(?))`,
      input.githubId,
      input.githubId,
      JSON.stringify(input.repoKeys),
    );
    return {
      available: Object.fromEntries(rows.map((p) => [p.repo_key, true])),
    };
  }
  async candidates(input: Input<"candidates.load">) {
    const actor = await this.user(input.githubId);
    if (!actor) throw new BridgeError(409, "profile_version_changed");
    const params: Value[] = [input.githubId, input.githubId];
    const base = `SELECT p.* FROM feed_projects p WHERE ${this.eligible()}`;
    const positive = actor.preferences
      .filter((p) => p.value > 0)
      .map((p) => p.tagId);
    const recalled = await Promise.all([
      recallTags(this.db, this.eligible(), input.githubId, positive),
      this.rows(
        `${base} ORDER BY p.analyzed_at DESC,p.repo_key LIMIT 40`,
        ...params,
      ),
      this.rows(
        `${base} ORDER BY p.product_score DESC,p.confidence DESC,p.analyzed_at DESC,p.repo_key LIMIT 20`,
        ...params,
      ),
      this.rows(
        `${base} AND (p.treasure_eligible=1 OR p.exposure_band='low') ORDER BY p.analyzed_at DESC,p.repo_key LIMIT 20`,
        ...params,
      ),
    ]);
    const sources = ["tag", "latest", "quality", "discovery"];
    const merged = new Map<string, { row: Row; sources: string[] }>();
    recalled.forEach((rows, index) =>
      rows.forEach((row) => {
        const key = String(row.repo_key);
        const known = merged.get(key);
        if (known) known.sources.push(sources[index]);
        else merged.set(key, { row, sources: [sources[index]] });
      }),
    );
    const selected = Array.from(merged.values()).slice(0, input.limit),
      keys = JSON.stringify(selected.map((v) => v.row.repo_key));
    const [tags, seen] = await Promise.all([
      this.rows(
        `SELECT p.repo_key,t.id,t.namespace,t.slug,t.label_zh AS labelZh,t.label_en AS labelEn,t.description,p.weight,p.confidence,p.taxonomy_version AS taxonomyVersion FROM feed_project_tags p JOIN feed_tag_definitions t ON t.id=p.tag_id AND t.status='canonical' WHERE p.repo_key IN(SELECT value FROM json_each(?)) ORDER BY p.repo_key,t.id`,
        keys,
      ),
      this.rows<{ repo_key: string; seen_at: number }>(
        `SELECT e.repo_key,MAX(e.occurred_at) AS seen_at FROM feed_events e
        JOIN feed_runtime_requests r ON r.id=e.request_id AND r.github_id=e.github_id
        JOIN feed_users u ON u.github_id=e.github_id AND u.profile_version=?
        WHERE e.github_id=? AND e.type='impression' AND e.repo_key IN(SELECT value FROM json_each(?))
        AND r.profile_version<=u.profile_version
        AND r.profile_version>COALESCE((SELECT profile_floor FROM feed_profile_floors f WHERE f.github_id=e.github_id),0)
        GROUP BY e.repo_key`,
        actor.profileVersion,
        input.githubId,
        keys,
      ),
    ]);
    const seenMap = new Map(
      seen.map((v) => [v.repo_key, new Date(v.seen_at).toISOString()]),
    );
    const candidates = selected.map(({ row: r, sources }) => {
      const projectTags = tags
        .filter((t) => t.repo_key === r.repo_key)
        .map(({ repo_key: _, ...t }) => t);
      const weighted = projectTags
        .map((t) => ({
          tag: t,
          pref: actor.preferences.find((p) => p.tagId === t.id),
        }))
        .filter((v) => v.pref);
      const weight = weighted.reduce(
        (s, v) => s + Number(v.tag.weight) * v.pref!.strength,
        0,
      );
      const affinity = weight
        ? weighted.reduce(
            (s, v) =>
              s + Number(v.tag.weight) * v.pref!.strength * v.pref!.value,
            0,
          ) / weight
        : null;
      const project = {
        repoKey: r.repo_key,
        itemId: String(r.repo_key).replace("/", ":"),
        ownerLogin: r.owner_login,
        name: r.name,
        canonicalUrl: r.canonical_url,
        summary: r.summary,
        language: r.language,
        topics: JSON.parse(String(r.topics_json)),
        projectType: r.project_type,
        lifecycle: r.lifecycle,
        productScore: r.product_score,
        confidence: r.confidence,
        verificationLevel: r.verification_level,
        exposureBand: r.exposure_band,
        treasureEligible: !!r.treasure_eligible,
        classicEligible: !!r.classic_eligible,
        analyzedAt: new Date(Number(r.analyzed_at)).toISOString(),
        publishable: true,
        submissionEvidence: true,
        tags: projectTags,
      };
      return {
        project,
        sources,
        tagAffinity: affinity,
        semanticSimilarity: null,
        seenAt: seenMap.get(String(r.repo_key)) ?? null,
        notInterested: false,
      };
    });
    return {
      candidates,
      counts: Object.fromEntries(
        recalled.map((rows, i) => [sources[i], rows.length]),
      ),
    };
  }
}

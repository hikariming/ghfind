import { BridgeError, hash, type Input } from "./contract";
import { FeedStore } from "./store";

export class FeedCommands extends FeedStore {
  async propose(input: Input<"taxonomy.propose">) {
    const command = crypto.randomUUID(),
      proposalId = `proposal_${crypto.randomUUID()}`,
      now = Date.now();
    const {
      writerEpoch: _epoch,
      expectedProfileVersion: _version,
      githubId: _actor,
      ...payload
    } = input;
    const digest = await hash(JSON.stringify(payload));
    const result = await this.batch([
      this.guard(command, input, input.githubId, {
        relation:
          "CASE WHEN EXISTS(SELECT 1 FROM feed_projects WHERE repo_key=?) THEN 1 ELSE 0 END",
        relationValues: [input.repoKey],
      }),
      this.sql(
        "INSERT INTO feed_proposal_guards(id,valid) VALUES(?,CASE WHEN NOT EXISTS(SELECT 1 FROM feed_tag_proposal_commands WHERE github_id=? AND command_id=? AND payload_hash<>?) THEN 1 ELSE 0 END)",
        command,
        input.githubId,
        input.id,
        digest,
      ),
      this.sql(
        `INSERT INTO feed_user_tag_proposals(id,repo_key,analysis_id,namespace,slug,label_zh,label_en,evidence_json,status,created_at,updated_at)
        SELECT ?,repo_key,analysis_id,?,?,?,?,?,'proposed',?,? FROM feed_projects WHERE repo_key=? AND NOT EXISTS(SELECT 1 FROM feed_tag_proposal_commands WHERE github_id=? AND command_id=?)
        ON CONFLICT(repo_key,analysis_id,namespace,slug) DO NOTHING`,
        proposalId,
        input.namespace,
        input.slug,
        input.labelZh,
        input.labelEn,
        JSON.stringify(input.evidence),
        now,
        now,
        input.repoKey,
        input.githubId,
        input.id,
      ),
      this.sql(
        `INSERT INTO feed_tag_proposal_commands(github_id,command_id,proposal_id,profile_version,payload_hash,created_at)
        SELECT ?,?,p.id,?,?,? FROM feed_user_tag_proposals p JOIN feed_projects f ON f.repo_key=p.repo_key AND f.analysis_id=p.analysis_id
        WHERE p.repo_key=? AND p.namespace=? AND p.slug=? ON CONFLICT(github_id,command_id) DO NOTHING`,
        input.githubId,
        input.id,
        input.expectedProfileVersion,
        digest,
        now,
        input.repoKey,
        input.namespace,
        input.slug,
      ),
      this.sql(
        "INSERT INTO feed_user_proposal_authors(proposal_id,github_id,profile_version) SELECT id,?,? FROM feed_user_tag_proposals WHERE id=? ON CONFLICT(proposal_id) DO NOTHING",
        input.githubId,
        input.expectedProfileVersion,
        proposalId,
      ),
      this.sql(
        "SELECT p.id AS proposalId,p.status FROM feed_tag_proposal_commands c JOIN feed_user_tag_proposals p ON p.id=c.proposal_id WHERE c.github_id=? AND c.command_id=?",
        input.githubId,
        input.id,
      ),
      this.sql("DELETE FROM feed_proposal_guards WHERE id=?", command),
      this.end(command),
    ]);
    return result[5].results[0] as { proposalId: string; status: string };
  }
  relation() {
    return `CASE WHEN EXISTS(SELECT 1 FROM feed_runtime_requests r JOIN feed_served_items s ON s.request_id=r.id WHERE r.id=? AND r.github_id=? AND r.profile_version<=? AND r.profile_version>COALESCE((SELECT profile_floor FROM feed_profile_floors f WHERE f.github_id=r.github_id),0) AND s.repo_key=?) THEN 1 ELSE 0 END`;
  }
  rebuildBehavior(githubId: number, now: number) {
    return [
      this.sql(
        "DELETE FROM feed_user_tag_preferences WHERE github_id=? AND source='behavior'",
        githubId,
      ),
      this.sql(
        `INSERT INTO feed_user_tag_preferences(github_id,tag_id,value,source,strength,taxonomy_version,updated_at)
        SELECT ?,t.tag_id,1,'behavior',MIN(0.6,SUM(CASE s.signal WHEN 'saved' THEN 0.3 WHEN 'outbound' THEN 0.1 ELSE 0.05 END * t.weight)),MAX(t.taxonomy_version),?
        FROM feed_behavior_signals s JOIN feed_project_tags t ON t.repo_key=s.repo_key JOIN feed_projects p ON p.repo_key=t.repo_key AND p.analysis_id=t.analysis_id JOIN feed_tag_definitions d ON d.id=t.tag_id AND d.status='canonical' AND d.taxonomy_version<=(SELECT version FROM feed_taxonomy_versions WHERE status='active')
        WHERE s.github_id=? GROUP BY t.tag_id`,
        githubId,
        now,
        githubId,
      ),
    ];
  }
  async saveRequest(input: Input<"requests.save">) {
    if (
      input.expectedProfileVersion !== input.user.profileVersion ||
      new Set(input.items.map((i) => i.project.repoKey)).size !==
        input.items.length ||
      new Set(input.items.map((i) => i.rank)).size !== input.items.length
    )
      throw new BridgeError(400, "invalid_request");
    const command = crypto.randomUUID(),
      now = Date.now(),
      id = input.user.githubId;
    const items = JSON.stringify(input.items);
    await this.batch([
      this.guard(command, input, id, {
        taxonomy: input.user.taxonomyVersion,
        payload:
          "CASE WHEN NOT EXISTS(SELECT 1 FROM feed_runtime_requests WHERE id=? AND (payload_hash<>? OR github_id<>?)) THEN 1 ELSE 0 END",
        payloadValues: [input.id, input.payloadHash, id],
        relation: `CASE WHEN (SELECT COUNT(*) FROM feed_projects p WHERE ${this.eligible()} AND p.repo_key IN(SELECT json_extract(value,'$.project.repoKey') FROM json_each(?)))=? THEN 1 ELSE 0 END`,
        relationValues: [id, id, items, input.items.length],
      }),
      this.sql(
        `INSERT INTO feed_runtime_requests(id,github_id,profile_version,taxonomy_version,algorithm_version,payload_hash,seed,candidate_counts_json,degraded_json,duration_ms,created_at)
        VALUES(?,?,?,?,'baseline-v1',?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`,
        input.id,
        id,
        input.user.profileVersion,
        input.user.taxonomyVersion,
        input.payloadHash,
        input.seed,
        JSON.stringify(input.candidateCounts),
        JSON.stringify(input.degraded),
        input.durationMs,
        now,
      ),
      this.sql(
        `INSERT INTO feed_served_items(request_id,github_id,repo_key,rank,algorithm_version,source,propensity,exploration,served_at)
        SELECT ?,?,json_extract(value,'$.project.repoKey'),json_extract(value,'$.rank'),'baseline-v1',json_extract(value,'$.candidateSources[0]'),json_extract(value,'$.propensity'),json_extract(value,'$.exploration'),? FROM json_each(?) WHERE 1 ON CONFLICT(request_id,repo_key) DO NOTHING`,
        input.id,
        id,
        now,
        items,
      ),
      this.sql(
        `INSERT INTO feed_runtime_served_metadata(request_id,repo_key,candidate_sources_json,reason_codes_json,features_json,score)
        SELECT ?,json_extract(value,'$.project.repoKey'),json_extract(value,'$.candidateSources'),json_extract(value,'$.reasonCodes'),json_extract(value,'$.features'),json_extract(value,'$.score') FROM json_each(?) WHERE 1 ON CONFLICT(request_id,repo_key) DO NOTHING`,
        input.id,
        items,
      ),
      this.end(command),
    ]);
    return { ok: true };
  }
  async state(input: Input<"state.set">) {
    const command = crypto.randomUUID(),
      now = Date.now(),
      field = input.saved === undefined ? "not_interested" : "saved",
      value = Number(input.saved ?? input.notInterested),
      opposite = field === "saved" ? "not_interested" : "saved";
    const type =
      field === "saved"
        ? value
          ? "save"
          : "unsave"
        : value
          ? "not_interested"
          : "undo_not_interested";
    const eventId = `state_${command}`;
    await this.batch([
      this.guard(command, input, input.githubId, {
        taxonomyRequestIds: [input.requestId],
        relation: this.relation(),
        relationValues: [
          input.requestId,
          input.githubId,
          input.expectedProfileVersion,
          input.repoKey,
        ],
      }),
      this.sql(
        `INSERT INTO feed_runtime_events(id,github_id,profile_version,repo_key,request_id,type,occurred_at,rank,state_value,payload_hash,command_id,created_at)
        SELECT ?,?,?,?,?,?,?,s.rank,?,?,?,? FROM feed_served_items s WHERE s.request_id=? AND s.repo_key=?
        AND COALESCE((SELECT ${field} FROM feed_user_project_states WHERE github_id=? AND repo_key=?),0)<>?`,
        eventId,
        input.githubId,
        input.expectedProfileVersion,
        input.repoKey,
        input.requestId,
        type,
        now,
        value,
        await hash(JSON.stringify(input)),
        command,
        now,
        input.requestId,
        input.repoKey,
        input.githubId,
        input.repoKey,
        value,
      ),
      this.sql(
        `INSERT INTO feed_user_project_states(github_id,repo_key,${field},${opposite},updated_at) VALUES(?,?,?,0,?)
        ON CONFLICT(github_id,repo_key) DO UPDATE SET ${field}=excluded.${field},${opposite}=CASE WHEN excluded.${field}=1 THEN 0 ELSE feed_user_project_states.${opposite} END,updated_at=excluded.updated_at`,
        input.githubId,
        input.repoKey,
        value,
        now,
      ),
      this.sql(
        "DELETE FROM feed_behavior_signals WHERE github_id=? AND repo_key=? AND signal='saved' AND NOT EXISTS(SELECT 1 FROM feed_user_project_states WHERE github_id=? AND repo_key=? AND saved=1)",
        input.githubId,
        input.repoKey,
        input.githubId,
        input.repoKey,
      ),
      this.sql(
        "INSERT INTO feed_behavior_signals(github_id,repo_key,signal,occurred_at) SELECT ?,?,'saved',? WHERE EXISTS(SELECT 1 FROM feed_user_project_states WHERE github_id=? AND repo_key=? AND saved=1) ON CONFLICT(github_id,repo_key,signal) DO NOTHING",
        input.githubId,
        input.repoKey,
        now,
        input.githubId,
        input.repoKey,
      ),
      ...this.rebuildBehavior(input.githubId, now),
      this.sql(
        "UPDATE feed_users SET profile_version=profile_version+1,updated_at=? WHERE github_id=? AND EXISTS(SELECT 1 FROM feed_runtime_events WHERE command_id=?)",
        now,
        input.githubId,
        command,
      ),
      this.sql(
        `INSERT INTO feed_runtime_outbox(id,topic,aggregate_key,profile_version,payload_json,available_at,created_at) SELECT ?,'feed.event-project.v1',?,(SELECT profile_version FROM feed_users WHERE github_id=?),?,?,? WHERE EXISTS(SELECT 1 FROM feed_runtime_events WHERE command_id=?)`,
        command,
        `gh:${input.githubId}`,
        input.githubId,
        JSON.stringify({ eventId, githubId: input.githubId }),
        now,
        now,
        command,
      ),
      this.end(command),
    ]);
    const result = await this.rows<{
      repoKey: string;
      saved: number;
      notInterested: number;
    }>(
      "SELECT repo_key AS repoKey,saved,not_interested AS notInterested FROM feed_user_project_states WHERE github_id=? AND repo_key=?",
      input.githubId,
      input.repoKey,
    );
    return {
      repoKey: input.repoKey,
      saved: !!result[0].saved,
      notInterested: !!result[0].notInterested,
    };
  }
  async events(input: Input<"events.append">) {
    const command = crypto.randomUUID(),
      now = Date.now();
    if (
      new Set(input.events.map((e) => e.input.id)).size !== input.events.length
    )
      throw new BridgeError(400, "invalid_request");
    const events = await Promise.all(
      input.events.map(async (e) => {
        const duration = e.input.durationMs ?? 0,
          qualified = e.input.type === "dwell" && duration >= 10000;
        if (
          Math.abs(Date.parse(e.input.occurredAt) - now) > 86400000 ||
          (e.metadata.durationMs ?? 0) !== duration ||
          !!e.metadata.qualified !== qualified ||
          (e.input.type !== "dwell" && duration !== 0)
        )
          throw new BridgeError(400, "invalid_request");
        return {
          id: e.input.id,
          repoKey: e.input.repoKey,
          requestId: e.requestId,
          type: e.input.type,
          occurredAt: Date.parse(e.input.occurredAt),
          rank: e.metadata.rank,
          algorithmVersion: e.metadata.algorithmVersion,
          durationMs: duration,
          qualified: Number(qualified),
          hash: await hash(
            JSON.stringify({
              ...e,
              input: { ...e.input, impressionToken: undefined },
            }),
          ),
        };
      }),
    );
    const encoded = JSON.stringify(events);
    const result = await this.batch([
      this.guard(command, input, input.githubId, {
        taxonomyRequestIds: events.map((event) => event.requestId),
        relation: `CASE WHEN NOT EXISTS(SELECT 1 FROM json_each(?) e WHERE NOT EXISTS(SELECT 1 FROM feed_runtime_requests r JOIN feed_served_items s ON r.id=s.request_id WHERE r.id=json_extract(e.value,'$.requestId') AND r.github_id=? AND r.profile_version<=? AND r.profile_version>COALESCE((SELECT profile_floor FROM feed_profile_floors f WHERE f.github_id=r.github_id),0) AND s.repo_key=json_extract(e.value,'$.repoKey') AND s.rank=json_extract(e.value,'$.rank') AND s.algorithm_version=json_extract(e.value,'$.algorithmVersion'))) THEN 1 ELSE 0 END`,
        relationValues: [encoded, input.githubId, input.expectedProfileVersion],
        payload: `CASE WHEN NOT EXISTS(SELECT 1 FROM json_each(?) j JOIN feed_runtime_events e ON e.id=json_extract(j.value,'$.id') WHERE e.github_id<>? OR e.payload_hash<>json_extract(j.value,'$.hash')) THEN 1 ELSE 0 END`,
        payloadValues: [encoded, input.githubId],
      }),
      this.sql(
        `INSERT INTO feed_runtime_events(id,github_id,profile_version,repo_key,request_id,type,occurred_at,rank,duration_ms,qualified,payload_hash,command_id,created_at)
        SELECT json_extract(value,'$.id'),?,?,json_extract(value,'$.repoKey'),json_extract(value,'$.requestId'),json_extract(value,'$.type'),json_extract(value,'$.occurredAt'),json_extract(value,'$.rank'),json_extract(value,'$.durationMs'),json_extract(value,'$.qualified'),json_extract(value,'$.hash'),?,? FROM json_each(?) WHERE 1 ON CONFLICT(id) DO NOTHING`,
        input.githubId,
        input.expectedProfileVersion,
        command,
        now,
        encoded,
      ),
      this.sql(
        `INSERT INTO feed_events(id,github_id,repo_key,type,occurred_at,duration_ms,request_id,rank,created_at) SELECT id,github_id,repo_key,type,occurred_at,duration_ms,request_id,rank,created_at FROM feed_runtime_events WHERE command_id=? ON CONFLICT(id) DO NOTHING`,
        command,
      ),
      this.sql(
        `INSERT INTO feed_behavior_signals(github_id,repo_key,signal,occurred_at) SELECT github_id,repo_key,CASE type WHEN 'github_outbound' THEN 'outbound' ELSE 'qualified_dwell' END,occurred_at FROM feed_runtime_events WHERE command_id=? AND (type='github_outbound' OR (type='dwell' AND qualified=1)) ON CONFLICT(github_id,repo_key,signal) DO NOTHING`,
        command,
      ),
      this.sql(
        "UPDATE feed_users SET profile_version=profile_version+1,updated_at=? WHERE github_id=? AND changes()>0",
        now,
        input.githubId,
      ),
      ...this.rebuildBehavior(input.githubId, now),
      this.sql(
        `INSERT INTO feed_runtime_outbox(id,topic,aggregate_key,profile_version,payload_json,available_at,created_at)
        SELECT id,'feed.event-project.v1',?,profile_version,json_object('eventId',id,'githubId',github_id),?,? FROM feed_runtime_events WHERE command_id=? ON CONFLICT(id) DO NOTHING`,
        `gh:${input.githubId}`,
        now,
        now,
        command,
      ),
      this.end(command),
    ]);
    const accepted = result[1].meta.changes;
    return { accepted, duplicate: input.events.length - accepted };
  }
  async putSession(input: Input<"sessions.put">) {
    const session = input.session,
      created = Date.parse(session.createdAt),
      expires = Date.parse(session.expiresAt),
      now = Date.now();
    if (
      session.profileVersion !== input.expectedProfileVersion ||
      expires <= now ||
      expires > created + 1800000 ||
      created > now + 30000 ||
      new Set(session.items.map((i) => i.project.repoKey)).size !==
        session.items.length
    )
      throw new BridgeError(400, "invalid_request");
    const payload = JSON.stringify(session),
      digest = await hash(payload),
      command = crypto.randomUUID();
    await this.batch([
      this.guard(command, input, session.githubId, {
        taxonomy: session.taxonomyVersion,
        payload:
          "CASE WHEN NOT EXISTS(SELECT 1 FROM feed_runtime_sessions WHERE id=? AND (payload_hash<>? OR github_id<>?)) THEN 1 ELSE 0 END",
        payloadValues: [session.id, digest, session.githubId],
      }),
      this.sql(
        "INSERT INTO feed_runtime_sessions(id,github_id,profile_version,payload_json,payload_hash,created_at,expires_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING",
        session.id,
        session.githubId,
        session.profileVersion,
        payload,
        digest,
        created,
        expires,
      ),
      this.end(command),
    ]);
    return { ok: true };
  }
  async getSession(input: Input<"sessions.get">) {
    const rows = await this.rows<{ payload_json: string }>(
      "SELECT s.payload_json FROM feed_runtime_sessions s JOIN feed_users u ON u.github_id=s.github_id AND u.profile_version=s.profile_version WHERE s.id=? AND s.github_id=? AND s.expires_at>? AND json_extract(s.payload_json,'$.taxonomyVersion')=(SELECT version FROM feed_taxonomy_versions WHERE status='active')",
      input.id,
      input.githubId,
      Date.now(),
    );
    if (!rows.length) throw new BridgeError(404, "session_not_found");
    return { session: JSON.parse(rows[0].payload_json) };
  }
  async deleteSession(input: Input<"sessions.delete">) {
    const command = crypto.randomUUID();
    await this.batch([
      this.guard(command, input, input.githubId),
      this.sql(
        "DELETE FROM feed_runtime_sessions WHERE id=? AND github_id=?",
        input.id,
        input.githubId,
      ),
      this.end(command),
    ]);
    return { ok: true };
  }
  async deleteProfile(input: Input<"profile.delete">) {
    const [generation] = await this.rows<{ value: number }>(
      "SELECT COALESCE((SELECT profile_version FROM feed_users WHERE github_id=?),(SELECT profile_floor FROM feed_profile_floors WHERE github_id=?),1) AS value",
      input.githubId,
      input.githubId,
    );
    const command = crypto.randomUUID(),
      deletionId = `feed_delete_${await hash(`${input.githubId}:${generation.value}`)}`,
      now = Date.now();
    await this.batch([
      this.guard(command, input, input.githubId, { allowAbsent: true }),
      this.sql(
        `INSERT INTO feed_profile_floors(github_id,profile_floor,deleted_at) VALUES(?,MAX(1,COALESCE((SELECT profile_version FROM feed_users WHERE github_id=?),0)),?)
        ON CONFLICT(github_id) DO UPDATE SET profile_floor=MAX(feed_profile_floors.profile_floor,excluded.profile_floor),deleted_at=excluded.deleted_at`,
        input.githubId,
        input.githubId,
        now,
      ),
      this.sql(
        "INSERT INTO feed_profile_deletions(id,github_id,profile_floor,status,requested_at) SELECT ?,github_id,profile_floor,'pending',? FROM feed_profile_floors WHERE github_id=? ON CONFLICT(id) DO NOTHING",
        deletionId,
        now,
        input.githubId,
      ),
      this.sql(
        "INSERT INTO feed_cleanup_jobs(deletion_id,github_id,profile_floor,requested_at,status,phase,available_at,updated_at) SELECT id,github_id,profile_floor,requested_at,'pending','primary',?,? FROM feed_profile_deletions WHERE id=? ON CONFLICT(deletion_id) DO NOTHING",
        now,
        now,
        deletionId,
      ),
      this.outbox(
        deletionId,
        "feed.user-delete.v1",
        input.githubId,
        { deletionId, githubId: input.githubId },
        now,
      ),
      this.sql(
        "DELETE FROM feed_runtime_sessions WHERE github_id=?",
        input.githubId,
      ),
      this.sql(
        "DELETE FROM feed_user_tag_preferences WHERE github_id=?",
        input.githubId,
      ),
      this.sql(
        "DELETE FROM feed_user_project_states WHERE github_id=?",
        input.githubId,
      ),
      this.sql(
        "DELETE FROM feed_behavior_signals WHERE github_id=?",
        input.githubId,
      ),
      this.sql("DELETE FROM feed_users WHERE github_id=?", input.githubId),
      this.sql(
        "DELETE FROM feed_rate_windows WHERE github_id=?",
        input.githubId,
      ),
      this.end(command),
    ]);
    const [deletion] = await this.rows<{ status: string }>(
      "SELECT status FROM feed_profile_deletions WHERE id=?",
      deletionId,
    );
    return { deletionId, status: deletion.status };
  }
  async deletion(input: Input<"profile.deletion.get">) {
    const rows = await this.rows<{ deletionId: string; status: string }>(
      "SELECT id AS deletionId,status FROM feed_profile_deletions WHERE id=? AND github_id=?",
      input.deletionId,
      input.githubId,
    );
    if (!rows.length) throw new BridgeError(404, "deletion_not_found");
    return rows[0];
  }
}

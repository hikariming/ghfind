import { BridgeError } from "./contract";
import { FeedStore } from "./store";

export const MARKER_RETENTION_MS = 180 * 86400000;
export class FeedArchive {
  constructor(
    private readonly bucket: R2Bucket,
    private readonly db: D1Database,
  ) {}
  key(githubId: number, generation: number, id: string) {
    if (
      !Number.isSafeInteger(githubId) ||
      githubId <= 0 ||
      !Number.isSafeInteger(generation) ||
      generation <= 0 ||
      !/^[a-zA-Z0-9_-]{1,120}$/.test(id)
    )
      throw new BridgeError(400, "invalid_archive_key");
    return `feed/v1/users/${githubId}/${generation}/${id}.json`;
  }
  private guard(
    store: FeedStore,
    command: string,
    githubId: number,
    generation: number,
    key: string,
    digest: string,
    epoch: number,
  ) {
    return store.sql(
      `INSERT INTO feed_archive_guards(id,writer_ok,profile_ok,payload_ok) VALUES(?,
      CASE WHEN EXISTS(SELECT 1 FROM feed_runtime_control WHERE id=1 AND writer_epoch=? AND writes_enabled=1) THEN 1 ELSE 0 END,
      CASE WHEN EXISTS(SELECT 1 FROM feed_users u WHERE github_id=? AND profile_version>=? AND ?>COALESCE((SELECT profile_floor FROM feed_profile_floors f WHERE f.github_id=u.github_id),0)) THEN 1 ELSE 0 END,
      CASE WHEN NOT EXISTS(SELECT 1 FROM feed_archive_objects WHERE object_key=? AND (payload_hash<>? OR status='erased')) THEN 1 ELSE 0 END)`,
      command,
      epoch,
      githubId,
      generation,
      generation,
      key,
      digest,
    );
  }
  async put(
    githubId: number,
    generation: number,
    id: string,
    body: Uint8Array,
    writerEpoch: number,
  ) {
    if (body.byteLength > 4 * 1024 * 1024)
      throw new BridgeError(413, "archive_too_large");
    const key = this.key(githubId, generation, id),
      digest = Array.from(
        new Uint8Array(
          await crypto.subtle.digest("SHA-256", new Uint8Array(body).buffer),
        ),
        (b) => b.toString(16).padStart(2, "0"),
      ).join(""),
      store = new FeedStore(this.db),
      command = crypto.randomUUID(),
      now = Date.now();
    // Registration and the deletion floor are checked in one transaction. A
    // deletion can therefore enumerate every old-generation in-flight key.
    await store.batch([
      this.guard(
        store,
        command,
        githubId,
        generation,
        key,
        digest,
        writerEpoch,
      ),
      store.sql(
        "INSERT INTO feed_archive_objects(object_key,github_id,profile_version,payload_hash,status,created_at) VALUES(?,?,?,?,'reserved',?) ON CONFLICT(object_key) DO NOTHING",
        key,
        githubId,
        generation,
        digest,
        now,
      ),
      store.sql("DELETE FROM feed_archive_guards WHERE id=?", command),
    ]);
    const result = await this.bucket.put(key, body, {
      httpMetadata: { contentType: "application/json" },
      customMetadata: { feedState: "stored", payloadHash: digest },
      onlyIf: { etagDoesNotMatch: "*" },
    });
    if (!result) {
      const existing = await this.bucket.head(key);
      if (existing?.customMetadata?.feedState === "erased")
        throw new BridgeError(409, "profile_version_changed");
      if (existing?.customMetadata?.payloadHash !== digest)
        throw new BridgeError(409, "archive_id_conflict");
    }
    try {
      await store.batch([
        this.guard(
          store,
          command,
          githubId,
          generation,
          key,
          digest,
          writerEpoch,
        ),
        store.sql(
          "UPDATE feed_archive_objects SET status='stored' WHERE object_key=?",
          key,
        ),
        store.sql("DELETE FROM feed_archive_guards WHERE id=?", command),
      ]);
    } catch (error) {
      // If deletion raced this put, overwrite content with a create-blocking
      // marker. Never delete the key: a delayed conditional put would resurrect.
      if (
        error instanceof BridgeError &&
        error.code === "profile_version_changed"
      )
        await this.erase(key, now);
      throw error;
    }
    return result;
  }
  async get(githubId: number, generation: number, id: string) {
    const store = new FeedStore(this.db),
      key = this.key(githubId, generation, id);
    const [row] = await store.rows<{ allowed: number }>(
      "SELECT EXISTS(SELECT 1 FROM feed_users u WHERE github_id=? AND profile_version>=? AND ?>COALESCE((SELECT profile_floor FROM feed_profile_floors f WHERE f.github_id=u.github_id),0)) AS allowed",
      githubId,
      generation,
      generation,
    );
    if (!row.allowed) return null;
    const object = await this.bucket.get(key);
    return object?.customMetadata?.feedState === "erased" ? null : object;
  }
  async erase(key: string, requestedAt: number) {
    await this.bucket.put(key, new Uint8Array(), {
      httpMetadata: { contentType: "application/octet-stream" },
      customMetadata: {
        feedState: "erased",
        retainUntil: String(requestedAt + MARKER_RETENTION_MS),
      },
    });
  }
  private async eraseGroup(keys: string[], requestedAt: number) {
    const results = await Promise.allSettled(
      keys.map((key) => this.erase(key, requestedAt)),
    );
    const failed = results.find((result) => result.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
  }
  async eraseRegistered(githubId: number, floor: number, requestedAt: number) {
    const store = new FeedStore(this.db),
      rows = await store.rows<{ object_key: string }>(
        "SELECT object_key FROM feed_archive_objects WHERE github_id=? AND profile_version<=? AND status<>'erased' ORDER BY object_key LIMIT 100",
        githubId,
        floor,
      );
    for (let i = 0; i < rows.length; i += 4) {
      const slice = rows.slice(i, i + 4);
      await this.eraseGroup(
        slice.map((row) => row.object_key),
        requestedAt,
      );
      await store.batch(
        slice.map((row) =>
          store.sql(
            "UPDATE feed_archive_objects SET status='erased',erased_at=?,retain_marker_until=? WHERE object_key=?",
            Date.now(),
            requestedAt + MARKER_RETENTION_MS,
            row.object_key,
          ),
        ),
      );
    }
    return rows.length;
  }
  async eraseLegacyPage(
    githubId: number,
    floor: number,
    requestedAt: number,
    cursor?: string,
  ) {
    const prefix = `feed/v1/users/${githubId}/`,
      page = await this.bucket.list({
        prefix,
        cursor,
        limit: 100,
        include: ["customMetadata"],
      });
    const old = page.objects.filter((object) => {
      const generation = Number(object.key.slice(prefix.length).split("/")[0]);
      return (
        (!Number.isSafeInteger(generation) || generation <= floor) &&
        object.customMetadata?.feedState !== "erased"
      );
    });
    for (let i = 0; i < old.length; i += 4)
      await this.eraseGroup(
        old.slice(i, i + 4).map((object) => object.key),
        requestedAt,
      );
    return {
      processed: old.length,
      cursor: page.truncated ? page.cursor : undefined,
      complete: !page.truncated,
    };
  }
}

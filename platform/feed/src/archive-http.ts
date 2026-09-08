import { Buffer } from "node:buffer";
import { z } from "zod";
import { FeedArchive } from "./archive";
import { BridgeError } from "./contract";
import { FeedStore } from "./store";

const integer = z.number().int().safe().positive();
const identity = {
  writerEpoch: integer,
  githubId: integer,
  profileVersion: integer,
  archiveId: z.string().regex(/^[a-zA-Z0-9_-]{1,120}$/),
};
const schemas = {
  health: z.strictObject({}),
  put: z.strictObject({ ...identity, bodyBase64: z.string().max(5592408) }),
  get: z.strictObject(identity),
};

export async function handleArchive(operation: string, raw: unknown, env: Env) {
  const store = new FeedStore(env.FEED_DB);
  if (operation === "health") {
    if (!schemas.health.safeParse(raw).success)
      throw new BridgeError(400, "invalid_request");
    const [control] = await store.rows<{
      schema_version: number;
      writer_epoch: number;
      writes_enabled: number;
    }>(
      "SELECT schema_version,writer_epoch,writes_enabled FROM feed_runtime_control WHERE id=1",
    );
    await store.rows("SELECT object_key FROM feed_archive_objects LIMIT 0");
    const [compatibility] = await store.rows<{ compatible: number }>(
      "SELECT min_reader_contract<=1 AND max_reader_contract>=1 AND min_writer_contract<=1 AND max_writer_contract>=1 AS compatible FROM feed_schema_compatibility WHERE id=1",
    );
    await env.FEED_ARCHIVE.head("health/archive-v1");
    return {
      ready:
        control.schema_version >= 7 &&
        control.writes_enabled === 1 &&
        compatibility?.compatible === 1,
      contractVersion: "1",
      writerEpoch: control.writer_epoch,
    };
  }
  if (operation !== "put" && operation !== "get")
    throw new BridgeError(404, "operation_not_found");
  const parsed = schemas[operation].safeParse(raw);
  if (!parsed.success) throw new BridgeError(400, "invalid_request");
  const input = parsed.data;
  const [control] = await store.rows<{ writer_epoch: number }>(
    "SELECT writer_epoch FROM feed_runtime_control WHERE id=1",
  );
  if (control.writer_epoch !== input.writerEpoch)
    throw new BridgeError(409, "writer_epoch_changed");
  const archive = new FeedArchive(env.FEED_ARCHIVE, env.FEED_DB);
  const key = archive.key(
    input.githubId,
    input.profileVersion,
    input.archiveId,
  );
  if (operation === "put") {
    const encoded = (input as z.infer<typeof schemas.put>).bodyBase64;
    const bytes = Buffer.from(encoded, "base64");
    if (bytes.length > 4 * 1024 * 1024)
      throw new BridgeError(413, "archive_too_large");
    if (bytes.toString("base64") !== encoded)
      throw new BridgeError(400, "invalid_archive_body");
    try {
      JSON.parse(
        new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
          bytes,
        ),
      );
    } catch {
      throw new BridgeError(400, "invalid_archive_body");
    }
    await archive.put(
      input.githubId,
      input.profileVersion,
      input.archiveId,
      bytes,
      input.writerEpoch,
    );
    return { key };
  }
  // The registry and hash are authoritative. Check deletion again after object
  // I/O so a request paused during erasure cannot return old user content.
  const visible = async () =>
    store.rows<{ payload_hash: string }>(
      `SELECT a.payload_hash FROM feed_archive_objects a JOIN feed_users u ON u.github_id=a.github_id
     WHERE a.object_key=? AND a.status='stored' AND u.profile_version>=a.profile_version
     AND a.profile_version>COALESCE((SELECT profile_floor FROM feed_profile_floors f WHERE f.github_id=a.github_id),0)`,
      key,
    );
  const [registered] = await visible();
  if (!registered) throw new BridgeError(404, "archive_not_found");
  const object = await archive.get(
    input.githubId,
    input.profileVersion,
    input.archiveId,
  );
  if (!object) throw new BridgeError(404, "archive_not_found");
  if (object.size > 4 * 1024 * 1024)
    throw new BridgeError(413, "archive_too_large");
  const bytes = await object.arrayBuffer();
  const hash = Buffer.from(
    await crypto.subtle.digest("SHA-256", bytes),
  ).toString("hex");
  if (hash !== registered.payload_hash)
    throw new BridgeError(409, "archive_id_conflict");
  const [stillVisible] = await visible();
  if (!stillVisible) throw new BridgeError(404, "archive_not_found");
  return { bodyBase64: Buffer.from(bytes).toString("base64") };
}

import { getD1Binding } from "@/lib/d1-client";

const MAX_BYTES = 350_000;
const TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

export function coverPath(repoKey: string): string {
  const [owner, name] = repoKey.split("/");
  return `/api/discover/covers/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
}

export function ownsRepo(login: string, repoKey: string): boolean {
  const owner = repoKey.split("/")[0] ?? "";
  return owner.length > 0 && login.toLowerCase() === owner.toLowerCase();
}

export async function attachCoverUrls<T extends { repoKey: string; coverUrl: string | null }>(cards: T[]): Promise<T[]> {
  const db = getD1Binding();
  if (!db || cards.length === 0) return cards;
  const keys = cards.map((card) => card.repoKey);
  const placeholders = keys.map(() => "?").join(", ");
  try {
    const rows = await db.prepare(
      `SELECT repo_key FROM discover_project_covers WHERE repo_key IN (${placeholders})`,
    ).bind(...keys).all();
    const present = new Set(rows.results.map((row) => String(row.repo_key)));
    return cards.map((card) => present.has(card.repoKey) ? { ...card, coverUrl: coverPath(card.repoKey) } : card);
  } catch {
    return cards;
  }
}

export async function readCover(repoKey: string): Promise<{ contentType: string; bytes: Uint8Array } | null> {
  const db = getD1Binding();
  if (!db) return null;
  try {
    const rows = await db.prepare(
      "SELECT content_type, image_base64 FROM discover_project_covers WHERE repo_key = ?",
    ).bind(repoKey).all();
    const row = rows.results[0];
    if (!row || typeof row.image_base64 !== "string" || typeof row.content_type !== "string") return null;
    return { contentType: row.content_type, bytes: Buffer.from(row.image_base64, "base64") };
  } catch {
    return null;
  }
}

export async function writeCover(input: {
  repoKey: string;
  contentType: string;
  bytes: Uint8Array;
  updatedBy: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!TYPES.has(input.contentType)) return { ok: false, error: "unsupported_type" };
  if (input.bytes.byteLength < 32 || input.bytes.byteLength > MAX_BYTES) return { ok: false, error: "invalid_size" };
  const db = getD1Binding();
  if (!db) return { ok: false, error: "storage_unavailable" };
  const image = Buffer.from(input.bytes).toString("base64");
  try {
    await db.prepare(
      `INSERT INTO discover_project_covers (repo_key, content_type, image_base64, updated_at, updated_by)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(repo_key) DO UPDATE SET
         content_type = excluded.content_type,
         image_base64 = excluded.image_base64,
         updated_at = excluded.updated_at,
         updated_by = excluded.updated_by`,
    ).bind(input.repoKey, input.contentType, image, new Date().toISOString(), input.updatedBy).all();
  } catch {
    return { ok: false, error: "storage_unavailable" };
  }
  return { ok: true };
}

export async function deleteCover(repoKey: string): Promise<void> {
  const db = getD1Binding();
  if (!db) return;
  await db.prepare("DELETE FROM discover_project_covers WHERE repo_key = ?").bind(repoKey).all();
}

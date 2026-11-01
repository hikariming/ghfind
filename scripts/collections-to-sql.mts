/**
 * Turns collection folders into SQL for the D1 collection tables
 * (migrations/0022_collections.sql). Each folder `<dir>/<slug>/` holds a
 * `meta.json` (same shape as the former content/collections entries) and
 * optional `<locale>.md` article bodies. Every slug's existing rows are
 * replaced, so the output works both as a seed and as an upsert:
 *
 *   pnpm tsx scripts/collections-to-sql.mts <dir> [slug ...] > /tmp/c.sql
 *   wrangler d1 execute ghfind --remote --file /tmp/c.sql
 *
 * Reading time is precomputed here (src/lib/blog.ts readingMinutes), so the
 * index and homepage never have to load article bodies.
 */
import { readdirSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { readingMinutes } from "../src/lib/blog";

type Localized = Record<string, string | undefined>;
type Meta = {
  type: string;
  status?: "draft" | "published";
  title: Localized;
  intro: Localized;
  publishedAt: string;
  tags?: string[];
  subject?: { kind: string; id: string; nickname?: string; headline?: Localized };
  items?: { kind: string; id: string; blurb: Localized; stats?: unknown }[];
};

const [dir, ...only] = process.argv.slice(2);
if (!dir) {
  console.error("usage: collections-to-sql.mts <dir> [slug ...]");
  process.exit(2);
}

const q = (value: string | number | null | undefined): string =>
  value === null || value === undefined
    ? "NULL"
    : typeof value === "number"
      ? String(value)
      : `'${value.replaceAll("'", "''")}'`;

const NOW = "CAST(strftime('%s', 'now') AS INTEGER) * 1000";
// D1 rejects statements over 100 KB; leave headroom for the SQL around a body.
const MAX_STATEMENT_BYTES = 95_000;

const out: string[] = [];
const emit = (sql: string) => {
  if (Buffer.byteLength(sql) > MAX_STATEMENT_BYTES) {
    throw new Error(`statement over ${MAX_STATEMENT_BYTES} bytes: ${sql.slice(0, 120)}…`);
  }
  out.push(sql);
};

const slugs = readdirSync(dir)
  .filter((slug) => existsSync(path.join(dir, slug, "meta.json")))
  .filter((slug) => only.length === 0 || only.includes(slug))
  .sort();

for (const slug of slugs) {
  if (!/^[a-z0-9-]+$/.test(slug)) throw new Error(`invalid slug: ${slug}`);
  const folder = path.join(dir, slug);
  const meta = JSON.parse(readFileSync(path.join(folder, "meta.json"), "utf8")) as Meta;
  const bodies = new Map(
    readdirSync(folder)
      .filter((f) => f.endsWith(".md"))
      .map((f) => [f.slice(0, -3), readFileSync(path.join(folder, f), "utf8")]),
  );
  const subject = meta.subject;
  const locales = [
    ...new Set([
      ...Object.keys(meta.title),
      ...Object.keys(meta.intro),
      ...Object.keys(subject?.headline ?? {}),
      ...bodies.keys(),
    ]),
  ].sort();

  out.push(`\n-- ${slug}`);
  for (const table of ["collection_item_translations", "collection_items", "collection_translations", "collections"]) {
    emit(`DELETE FROM ${table} WHERE slug = ${q(slug)};`);
  }
  emit(
    `INSERT INTO collections (slug, type, status, published_at, tags, subject_kind, subject_id, subject_nickname, created_at, updated_at) VALUES (` +
      [
        q(slug),
        q(meta.type),
        q(meta.status ?? "published"),
        q(meta.publishedAt),
        q(JSON.stringify(meta.tags ?? [])),
        q(subject?.kind),
        q(subject?.id),
        q(subject?.nickname),
        NOW,
        NOW,
      ].join(", ") +
      ");",
  );
  for (const locale of locales) {
    const body = bodies.get(locale);
    emit(
      `INSERT INTO collection_translations (slug, locale, title, intro, subject_headline, body, reading_minutes) VALUES (` +
        [
          q(slug),
          q(locale),
          q(meta.title[locale]),
          q(meta.intro[locale]),
          q(subject?.headline?.[locale]),
          q(body),
          body === undefined ? "NULL" : String(readingMinutes(body)),
        ].join(", ") +
        ");",
    );
  }
  (meta.items ?? []).forEach((item, position) => {
    emit(
      `INSERT INTO collection_items (slug, position, kind, item_id, stats) VALUES (` +
        [q(slug), position, q(item.kind), q(item.id), q(JSON.stringify(item.stats ?? {}))].join(", ") +
        ");",
    );
    for (const [locale, blurb] of Object.entries(item.blurb)) {
      if (!blurb) continue;
      emit(
        `INSERT INTO collection_item_translations (slug, position, locale, blurb) VALUES (` +
          [q(slug), position, q(locale), q(blurb)].join(", ") +
          ");",
      );
    }
  });
}

process.stdout.write(out.join("\n") + "\n");

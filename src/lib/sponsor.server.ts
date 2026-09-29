/** Current title sponsor identity and its embedded logo for generated cards. */

import assets from "@/generated/embedded-assets.json";
import { getD1Binding } from "@/lib/d1-client";

export interface CurrentTitleSponsor {
  name: string;
  url: string | null;
  description: string | null;
  logo: string | null;
}

/**
 * Never throws: every card route awaits this, and a sponsor lookup failure
 * (e.g. the `sponsorships` migration not yet applied) must drop the logo, not
 * 500 an image embedded in someone else's README.
 */
export async function getCurrentTitleSponsor(
  size: "small" | "full" = "full",
): Promise<CurrentTitleSponsor | null> {
  try {
    return await loadCurrentTitleSponsor(size);
  } catch (err) {
    console.error("getCurrentTitleSponsor failed", err);
    return null;
  }
}

async function loadCurrentTitleSponsor(
  size: "small" | "full",
): Promise<CurrentTitleSponsor | null> {
  const db = getD1Binding();
  if (!db) return null;

  const now = Date.now();
  const { results } = await db
    .prepare(
      `SELECT sponsor_name, sponsor_url, icon_url, description, is_anonymous
       FROM sponsorships
       WHERE tier = '夯'
         AND (started_at IS NULL OR started_at <= ?)
         AND (expires_at IS NULL OR expires_at > ?)
       ORDER BY COALESCE(started_at, 0), created_at, id
       LIMIT 1`,
    )
    .bind(now, now)
    .all();

  const row = results[0];
  if (!row) return null;

  const isAnonymous = row.is_anonymous === 1;
  const iconUrl = typeof row.icon_url === "string" ? row.icon_url : null;
  const embedded = (assets.sponsor as Record<string, string>)[iconUrl ?? ""];
  const smallPath = iconUrl?.replace(/(\.[^./]+)$/, "-32$1");
  const logo = size === "small" && smallPath
    ? (assets.sponsor as Record<string, string>)[smallPath] ?? embedded ?? null
    : embedded ?? null;

  return {
    name: isAnonymous
      ? "Anonymous sponsor"
      : typeof row.sponsor_name === "string"
        ? row.sponsor_name
        : "Sponsor",
    url: !isAnonymous && typeof row.sponsor_url === "string" ? row.sponsor_url : null,
    description: !isAnonymous && typeof row.description === "string" ? row.description : null,
    logo,
  };
}

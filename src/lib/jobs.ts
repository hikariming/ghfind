import { getD1Binding } from "@/lib/d1-client";

/**
 * Hiring board read model (migrations/0020_jobs.sql). Copy is per locale in
 * job_translations, falling back to en, then zh. Reads never throw: with no
 * D1 binding (the Next static build) or a failed query the board is empty.
 */

export const EMPLOYMENT_TYPES = ["full_time", "intern", "part_time"] as const;
export type EmploymentType = (typeof EMPLOYMENT_TYPES)[number];

export type JobListing = {
  id: string;
  applyUrl: string;
  employmentTypes: EmploymentType[];
  pinned: boolean;
  company: { id: string; name: string; logoUrl: string | null; sponsor: boolean };
  title: string;
  category: string | null;
  location: string | null;
  salary: string | null;
  summary: string | null;
  /** True when a full JD exists, so the card opens /jobs/<id> instead of applyUrl. */
  hasDetail: boolean;
};

/** One job with its full JD markdown, for /jobs/<id>. */
export type JobDetail = JobListing & {
  description: string;
  company: JobListing["company"] & { websiteUrl: string | null; careersUrl: string | null };
};

export type JobCompany = {
  id: string;
  name: string;
  logoUrl: string | null;
  websiteUrl: string | null;
  careersUrl: string | null;
  sponsor: boolean;
  openJobs: number;
};

const str = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

const field = (name: string) =>
  `COALESCE(t.${name}, te.${name}, tz.${name}) AS ${name}`;

const LISTING_COLUMNS = `j.id, j.apply_url, j.employment_types, j.is_pinned,
                c.id AS company_id, c.name AS company_name, c.logo_url, c.is_sponsor,
                ${["title", "category", "location", "salary", "summary"].map(field).join(", ")},
                COALESCE(t.description, te.description, tz.description) IS NOT NULL AS has_detail`;

const LISTING_FROM = `FROM jobs j
         JOIN job_companies c ON c.id = j.company_id
         LEFT JOIN job_translations t  ON t.job_id = j.id AND t.locale = ?
         LEFT JOIN job_translations te ON te.job_id = j.id AND te.locale = 'en'
         LEFT JOIN job_translations tz ON tz.job_id = j.id AND tz.locale = 'zh'
         WHERE j.status = 'open' AND (j.expires_at IS NULL OR j.expires_at > ?)`;

function toListing(row: Record<string, unknown>): JobListing | null {
  const title = str(row.title);
  const applyUrl = str(row.apply_url);
  if (!title || !applyUrl) return null;
  return {
    id: String(row.id),
    applyUrl,
    employmentTypes: String(row.employment_types ?? "")
      .split(",")
      .filter((type): type is EmploymentType => (EMPLOYMENT_TYPES as readonly string[]).includes(type)),
    pinned: row.is_pinned === 1,
    company: {
      id: String(row.company_id),
      name: String(row.company_name),
      logoUrl: str(row.logo_url),
      sponsor: row.is_sponsor === 1,
    },
    title,
    category: str(row.category),
    location: str(row.location),
    salary: str(row.salary),
    summary: str(row.summary),
    hasDetail: row.has_detail === 1,
  };
}

export async function listJobs(
  locale: string,
  { companyId, limit = 200 }: { companyId?: string; limit?: number } = {},
): Promise<JobListing[]> {
  const db = getD1Binding();
  if (!db) return [];
  try {
    const { results } = await db
      .prepare(
        `SELECT ${LISTING_COLUMNS}
         ${LISTING_FROM}
           AND (? IS NULL OR j.company_id = ?)
         ORDER BY j.is_pinned DESC, j.display_order, j.id
         LIMIT ?`,
      )
      .bind(locale, Date.now(), companyId ?? null, companyId ?? null, limit)
      .all();
    return results.flatMap((row) => {
      const listing = toListing(row);
      return listing ? [listing] : [];
    });
  } catch {
    return [];
  }
}

/**
 * One open job with its full JD, or null when it is unknown, closed or has no
 * description (those keep linking straight to apply_url). D1 errors propagate
 * so a transient failure is a 5xx, not a cached 404.
 */
export async function getJob(locale: string, id: string): Promise<JobDetail | null> {
  const db = getD1Binding();
  if (!db) return null;
  const { results } = await db
    .prepare(
      `SELECT ${LISTING_COLUMNS},
              COALESCE(t.description, te.description, tz.description) AS description,
              c.website_url, c.careers_url
       ${LISTING_FROM}
         AND j.id = ?`,
    )
    .bind(locale, Date.now(), id)
    .all();
  const row = results[0];
  const listing = row ? toListing(row) : null;
  const description = row ? str(row.description) : null;
  if (!row || !listing || !description) return null;
  return {
    ...listing,
    description,
    company: { ...listing.company, websiteUrl: str(row.website_url), careersUrl: str(row.careers_url) },
  };
}

/** Companies with at least one open job, sponsors first. */
export async function listJobCompanies(): Promise<JobCompany[]> {
  const db = getD1Binding();
  if (!db) return [];
  try {
    const { results } = await db
      .prepare(
        `SELECT c.id, c.name, c.logo_url, c.website_url, c.careers_url, c.is_sponsor,
                COUNT(j.id) AS open_jobs
         FROM job_companies c
         JOIN jobs j ON j.company_id = c.id
         WHERE j.status = 'open' AND (j.expires_at IS NULL OR j.expires_at > ?)
         GROUP BY c.id
         ORDER BY c.is_sponsor DESC, c.display_order, c.name`,
      )
      .bind(Date.now())
      .all();
    return results.map((row) => ({
      id: String(row.id),
      name: String(row.name),
      logoUrl: str(row.logo_url),
      websiteUrl: str(row.website_url),
      careersUrl: str(row.careers_url),
      sponsor: row.is_sponsor === 1,
      openJobs: Number(row.open_jobs) || 0,
    }));
  } catch {
    return [];
  }
}

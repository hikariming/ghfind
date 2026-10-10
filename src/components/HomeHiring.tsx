import { ArrowUpRight, Megaphone, Trophy } from "lucide-react";
import { Link } from "@/i18n/navigation";
import type { JobListing } from "@/lib/jobs";
import type { Translator } from "@/lib/translator";

/**
 * Homepage "developer hiring" band — first block of the main column, above
 * the founder's picks. Jobs come pre-resolved from D1 (src/lib/jobs.ts);
 * static: cards are plain links, so it ships no JS.
 */
export function HomeHiring({ jobs, t }: { jobs: JobListing[]; /** "jobs" namespace. */ t: Translator }) {
  if (jobs.length === 0) return null;
  return (
    <section className="w-full">
      <div className="flex items-end justify-between gap-4">
        <div className="min-w-0">
          <h2 className="text-xl font-black tracking-tight text-zinc-100 sm:text-2xl">
            {t("heading")}
          </h2>
          <p className="mt-1 text-sm text-zinc-400">{t("subtitle")}</p>
        </div>
        <div className="flex shrink-0 items-center gap-3 text-sm">
          <Link href="/contact" prefetch={false} className="hiring-post underline-offset-4 hover:underline">
            {t("postJob")}
          </Link>
          <span aria-hidden="true" className="text-zinc-600">|</span>
          <Link
            href="/jobs"
            prefetch={false}
            className="text-zinc-400 underline-offset-4 transition-colors hover:text-zinc-200 hover:underline"
          >
            {t("viewAll")} →
          </Link>
        </div>
      </div>
      <div className="hiring-grid">
        {jobs.map((job) => (
          <HiringCard key={job.id} job={job} t={t} />
        ))}
      </div>
      <SponsorNote t={t} />
    </section>
  );
}

export function SponsorNote({ t }: { t: Translator }) {
  return (
    <div className="hiring-note">
      <Megaphone className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      <span>{t("sponsorNote")}</span>
      <span className="hiring-note-rule" aria-hidden="true" />
      <Link href="/sponsor" prefetch={false} className="hiring-post shrink-0 underline-offset-4 hover:underline">
        {t("becomeSponsor")} ↗
      </Link>
    </div>
  );
}

/** One job card; opens the company's own job post in a new tab. */
export function HiringCard({ job, t, showSummary = false }: { job: JobListing; t: Translator; showSummary?: boolean }) {
  const details = [job.location, job.category].filter(Boolean).join(" · ");
  return (
    <a
      href={job.applyUrl}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={`${job.title} · ${job.company.name}`}
      className={`hiring-card${job.pinned ? " hiring-card-sponsored" : ""}`}
    >
      <div className="hiring-company">
        <span className="hiring-logo" aria-hidden="true">
          {job.company.logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element -- tiny static logo
            <img src={job.company.logoUrl} alt="" loading="lazy" />
          ) : (
            job.company.name.slice(0, 1)
          )}
        </span>
        <span className="hiring-company-name">{job.company.name}</span>
        {job.pinned && (
          <span className="hiring-badge">
            <Trophy className="h-3 w-3" aria-hidden="true" />
            {t("sponsored")}
          </span>
        )}
      </div>
      <h3 className="line-clamp-2">{job.title}</h3>
      {job.salary && <p className="hiring-salary">{job.salary}</p>}
      {details && <p className="hiring-location line-clamp-2">{details}</p>}
      {showSummary && job.summary && <p className="hiring-summary line-clamp-3">{job.summary}</p>}
      <div className="hiring-tags">
        {job.employmentTypes.map((type) => (
          <span key={type}>{t(`type.${type}`)}</span>
        ))}
        <ArrowUpRight className="hiring-arrow" aria-hidden="true" />
      </div>
    </a>
  );
}

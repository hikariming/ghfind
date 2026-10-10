import { ArrowUpRight, Megaphone, Trophy } from "lucide-react";
import { Link } from "@/i18n/navigation";
import { homeJobs, jobText, type HomeJob } from "@/lib/home-jobs";
import type { Translator } from "@/lib/translator";

/**
 * Homepage "developer hiring" band — first block of the main column, above
 * the founder's picks. Static: cards are plain links, so it ships no JS.
 */
export function HomeHiring({ locale, t }: { locale: string; /** "home" namespace. */ t: Translator }) {
  const jobs = homeJobs();
  if (jobs.length === 0) return null;
  return (
    <section className="w-full">
      <div className="flex items-end justify-between gap-4">
        <div className="min-w-0">
          <h2 className="text-xl font-black tracking-tight text-zinc-100 sm:text-2xl">
            {t("hiring.heading")}
          </h2>
          <p className="mt-1 text-sm text-zinc-400">{t("hiring.subtitle")}</p>
        </div>
        <Link
          href="/contact"
          prefetch={false}
          className="hiring-post shrink-0 text-sm underline-offset-4 hover:underline"
        >
          {t("hiring.postJob")}
        </Link>
      </div>
      <div className="hiring-grid">
        {jobs.map((job) => (
          <HiringCard key={job.id} job={job} locale={locale} sponsoredLabel={t("hiring.sponsored")} />
        ))}
      </div>
      <div className="hiring-note">
        <Megaphone className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <span>{t("hiring.sponsorNote")}</span>
        <span className="hiring-note-rule" aria-hidden="true" />
        <Link href="/sponsor" prefetch={false} className="hiring-post shrink-0 underline-offset-4 hover:underline">
          {t("hiring.becomeSponsor")} ↗
        </Link>
      </div>
    </section>
  );
}

function HiringCard({ job, locale, sponsoredLabel }: { job: HomeJob; locale: string; sponsoredLabel: string }) {
  const title = jobText(job.title, locale);
  const body = (
    <>
      <div className="hiring-company">
        <span className="hiring-logo" aria-hidden="true">
          {job.logo ? (
            // eslint-disable-next-line @next/next/no-img-element -- tiny static logo
            <img src={job.logo} alt="" loading="lazy" />
          ) : (
            job.company.slice(0, 1)
          )}
        </span>
        <span className="hiring-company-name">{job.company}</span>
        {job.sponsored && (
          <span className="hiring-badge">
            <Trophy className="h-3 w-3" aria-hidden="true" />
            {sponsoredLabel}
          </span>
        )}
      </div>
      <h3 className="line-clamp-1">{title}</h3>
      <p className="hiring-salary">{jobText(job.salary, locale)}</p>
      <p className="hiring-location">{jobText(job.location, locale)}</p>
      <div className="hiring-tags">
        {job.tags.map((tag) => (
          <span key={tag}>{tag}</span>
        ))}
        <ArrowUpRight className="hiring-arrow" aria-hidden="true" />
      </div>
    </>
  );
  const className = `hiring-card${job.sponsored ? " hiring-card-sponsored" : ""}`;
  return job.href.startsWith("/") ? (
    <Link href={job.href} prefetch={false} aria-label={`${title} · ${job.company}`} className={className}>
      {body}
    </Link>
  ) : (
    <a href={job.href} target="_blank" rel="noopener noreferrer" aria-label={`${title} · ${job.company}`} className={className}>
      {body}
    </a>
  );
}

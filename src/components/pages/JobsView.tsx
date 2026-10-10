import { ArrowUpRight } from "lucide-react";
import { HiringCard, SponsorNote } from "@/components/HomeHiring";
import { Link } from "@/i18n/navigation";
import type { JobCompany, JobListing } from "@/lib/jobs";
import type { Translator } from "@/lib/translator";

/**
 * The /jobs board, shared by the Next app and apps/web. Fully static HTML:
 * the company filter is plain links (`?company=`), cards link out to each
 * company's own job post.
 */
export function JobsView({
  t,
  companies,
  selected,
  jobs,
}: {
  /** "jobs" namespace. */
  t: Translator;
  companies: JobCompany[];
  selected: string | null;
  jobs: JobListing[];
}) {
  const total = companies.reduce((sum, c) => sum + c.openJobs, 0);
  const shown = selected ? companies.filter((c) => c.id === selected) : companies;
  return (
    <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col px-5 pb-20 pt-10 sm:px-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-2xl font-black tracking-tight text-zinc-100 sm:text-3xl">{t("heading")}</h1>
          <p className="mt-2 text-sm text-zinc-400 sm:text-base">{t("subtitle")}</p>
        </div>
        <Link href="/contact" prefetch={false} className="hiring-post shrink-0 text-sm underline-offset-4 hover:underline">
          {t("postJob")}
        </Link>
      </header>

      <nav aria-label={t("filterLabel")} className="jobs-filter">
        <Link href="/jobs" prefetch={false} aria-current={selected === null ? "page" : undefined}>
          {t("allCompanies")} <span>{total}</span>
        </Link>
        {companies.map((c) => (
          <Link key={c.id} href={`/jobs?company=${c.id}`} prefetch={false} aria-current={selected === c.id ? "page" : undefined}>
            {c.name} <span>{c.openJobs}</span>
          </Link>
        ))}
      </nav>

      {jobs.length === 0 ? (
        <p className="mt-16 text-center text-sm text-zinc-400">{t("empty")}</p>
      ) : (
        shown.map((company) => {
          const companyJobs = jobs.filter((job) => job.company.id === company.id);
          if (companyJobs.length === 0) return null;
          return (
            <section key={company.id} className="jobs-company" aria-labelledby={`jobs-${company.id}`}>
              <div className="jobs-company-head">
                <span className="hiring-logo" aria-hidden="true">
                  {company.logoUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element -- tiny static logo
                    <img src={company.logoUrl} alt="" loading="lazy" />
                  ) : (
                    company.name.slice(0, 1)
                  )}
                </span>
                <h2 id={`jobs-${company.id}`}>{company.name}</h2>
                {company.sponsor && <span className="jobs-sponsor-tag">{t("sponsorTag")}</span>}
                <span className="text-sm text-zinc-500">{t("openJobs", { count: companyJobs.length })}</span>
                {company.careersUrl && (
                  <a href={company.careersUrl} target="_blank" rel="noopener noreferrer" className="jobs-careers">
                    {t("careersSite")} <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
                  </a>
                )}
              </div>
              <div className="hiring-grid">
                {companyJobs.map((job) => (
                  <HiringCard key={job.id} job={job} t={t} showSummary />
                ))}
              </div>
            </section>
          );
        })
      )}

      <div className="mt-10">
        <SponsorNote t={t} />
        <p className="mt-3 text-xs text-zinc-500">{t("disclaimer")}</p>
      </div>
    </main>
  );
}

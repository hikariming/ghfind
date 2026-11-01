import { ArrowLeft, ArrowUpRight, Mail, Trophy } from "lucide-react";
import { AnalysisReport } from "@/components/AnalysisReport";
import { Link } from "@/i18n/navigation";
import type { JobDetail } from "@/lib/jobs";
import type { Translator } from "@/lib/translator";

/** Email address behind a `mailto:` apply link, or null for web links. */
function applyEmail(url: string): string | null {
  if (!url.startsWith("mailto:")) return null;
  return decodeURIComponent(url.slice("mailto:".length).split("?")[0]) || null;
}

/**
 * /jobs/<id>: the full JD for listings that carry a description, shared by the
 * Next app and apps/web. Static HTML; Apply opens the company's mail or
 * careers link, never a ghfind form.
 */
export function JobDetailView({ t, job }: { /** "jobs" namespace. */ t: Translator; job: JobDetail }) {
  const email = applyEmail(job.applyUrl);
  const meta = [job.location, job.category].filter(Boolean).join(" · ");
  const companySite = job.company.careersUrl ?? job.company.websiteUrl;
  const applyClass =
    "inline-flex items-center justify-center gap-2 rounded-xl bg-orange-500 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-orange-400";
  const apply = email ? (
    <a href={job.applyUrl} className={applyClass}>
      <Mail className="h-4 w-4" aria-hidden="true" />
      {t("applyByEmail")}
    </a>
  ) : (
    <a href={job.applyUrl} target="_blank" rel="noopener noreferrer" className={applyClass}>
      {t("apply")}
      <ArrowUpRight className="h-4 w-4" aria-hidden="true" />
    </a>
  );

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col px-5 pb-20 pt-10 sm:px-6">
      <Link href="/jobs" prefetch={false} className="inline-flex items-center gap-1.5 self-start text-sm text-zinc-400 hover:text-zinc-200">
        <ArrowLeft className="h-4 w-4" aria-hidden="true" />
        {t("backToJobs")}
      </Link>

      <header className="mt-6 rounded-2xl border border-white/10 bg-white/[0.02] p-6">
        <div className="hiring-company">
          <span className="hiring-logo" aria-hidden="true">
            {job.company.logoUrl ? (
              // eslint-disable-next-line @next/next/no-img-element -- tiny static logo
              <img src={job.company.logoUrl} alt="" />
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
        <h1 className="mt-4 text-2xl font-black tracking-tight text-zinc-100 sm:text-3xl">{job.title}</h1>
        {job.salary && <p className="hiring-salary mt-2">{job.salary}</p>}
        {meta && <p className="mt-1 text-sm text-zinc-400">{meta}</p>}
        <div className="hiring-tags mt-4">
          {job.employmentTypes.map((type) => (
            <span key={type}>{t(`type.${type}`)}</span>
          ))}
        </div>
        <div className="mt-6 flex flex-wrap items-center gap-x-4 gap-y-2">
          {apply}
          {email && <span className="text-sm text-zinc-400">{t("emailNote", { email })}</span>}
        </div>
      </header>

      <article className="mt-8">
        <AnalysisReport markdown={job.description} />
      </article>

      <div className="mt-10 flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-white/10 pt-6">
        {apply}
        {companySite && (
          <a
            href={companySite}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-sm text-zinc-400 hover:text-zinc-200"
          >
            {t("careersSite")} <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
          </a>
        )}
      </div>
      <p className="mt-4 text-xs text-zinc-500">{t("detailNote")}</p>
    </main>
  );
}

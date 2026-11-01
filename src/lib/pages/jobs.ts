import { listJobCompanies, listJobs } from "@/lib/jobs";

/**
 * Data for the /jobs page, shared by the Next page and apps/web. `?company=`
 * narrows the board to one company; unknown ids fall back to every company.
 */
export async function loadJobsPage(locale: string, company: string | null | undefined) {
  const companies = await listJobCompanies();
  const selected = companies.find((c) => c.id === company)?.id ?? null;
  const jobs = await listJobs(locale, { companyId: selected ?? undefined });
  return { companies, selected, jobs };
}

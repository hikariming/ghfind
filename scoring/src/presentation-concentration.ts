import type { RawMetrics, RecentPr } from "./types";

const UI_LIBRARY = /(^|[-_./])(ui|design|design-system|components?|widgets?|styles?|css|themes?|antd|mui|chakra|shadcn|patternfly|tailwind(css)?)([-_./]|$)/i;
const CORE_FILE = /\.(c|cc|cpp|cs|go|java|js|jsx|kt|m|mm|php|py|rb|rs|scala|swift|ts|tsx|vue|svelte|css|scss|sass|less|styl)$/i;
const STYLE = /\.(css|scss|sass|less|styl)$/i;
const SITE = /(^|[-_./])(site|website|blog|docs?|homepage)([-_./]|$)|site$|\.github\.io$/i;

/** Classify presentation paths, never generic application frontend code. */
export function isPresentationPath(path: string, repo: string, docSite = false): boolean {
  const p = path.toLowerCase();
  if (/\.(c|cc|cpp|cs|go|java|kt|m|mm|php|py|rb|rs|scala|swift)$/.test(p)) return false;
  if (/(^|\/)(server|backend|api|database|db|auth)(\/|$)/.test(p) && /\.(jsx?|tsx?)$/.test(p)) return false;
  if (UI_LIBRARY.test(repo) && STYLE.test(p)) return false;
  return /(^|\/)(assets?|public|static)\/.*(?:\.[a-z0-9_-]{6,}\.m?js|\.min\.js)$/i.test(p) ||
    /\.(md|mdx|rst|adoc|txt|svg|png|jpe?g|gif|webp|css|scss|sass|less|styl)$/i.test(p) ||
    /(^|\/)(docs?|site|website|blog|content|articles|examples?|templates?|tutorials?|guides?|manual|i18n|locales?|__snapshots__|demos?|storybook|screenshots?)(\/|$)/.test(p) ||
    /(^|\/)(readme|changelog|contributing|license)(\.[^/]*)?$/.test(p) ||
    /(^|\/)(pages\/home|components\/home[^/]*)(\/|$)/.test(p) ||
    ((SITE.test(repo.split("/").at(-1) ?? repo) || docSite) && !UI_LIBRARY.test(repo) && (/\.(jsx?|tsx?|vue|svelte|astro|html)$/.test(p) || /(^|\/)(package(-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|tsconfig\.json)$/.test(p)));
}

/** Missing/truncated file evidence is neutral; never infer line counts from titles. */
export function presentationSignals(prs: RecentPr[], login: string, ownRepos: string[] = [], ownShares: Record<string, number> = {}) {
  const owned = new Set(ownRepos.map(r => r.toLowerCase()));
  let churn = 0, presentation = 0, coreChurn = 0, n = 0, core = 0;
  const byRepo = new Map<string, number>();
  for (const pr of prs) {
    const repo = pr.repo?.toLowerCase() ?? "";
    if (!repo.includes("/") || repo.split("/")[0] === login.toLowerCase()) continue;
    const external = owned.has(repo) ? 1-Math.max(0,Math.min(1,ownShares[repo] ?? 1)) : 1;
    if (external <= 0) continue;
    const files = pr.file_changes;
    if (!files?.length || files.length < pr.changed_files) continue;
    const total = files.reduce((s, f) => s + Math.max(0, f.additions) + Math.max(0, f.deletions), 0);
    if (total <= 0) continue;
    const docSite = files.some(f => /(^|\/)docusaurus\.config\.[cm]?[jt]s$/.test(f.path));
    const amount = files.reduce((s, f) => s + (isPresentationPath(f.path, repo, docSite) ? Math.max(0, f.additions) + Math.max(0, f.deletions) : 0), 0);
    coreChurn += external * files.reduce((sum, f) => sum + (CORE_FILE.test(f.path) && !isPresentationPath(f.path, repo, docSite) ? Math.max(0, f.additions) + Math.max(0, f.deletions) : 0), 0);
    churn += external*total; presentation += external*amount; n += external;
    if (total > 5 && amount / total <= 0.4 && pr.repo_stars >= 200) core += external;
    byRepo.set(repo, (byRepo.get(repo) ?? 0) + external*amount);
  }
  const shares = [...byRepo.values()].sort((a,b) => b-a);
  return {
    presentation_churn_share: churn > 0 ? presentation / churn : 0,
    presentation_core_churn_share: churn > 0 ? coreChurn / churn : 0,
    presentation_repo_concentration: presentation > 0 ? ((shares[0] ?? 0) + (shares[1] ?? 0)) / presentation : 0,
    presentation_pr_sample: n,
    presentation_core_pr_count: core,
  };
}

export function presentationDiscount(m: RawMetrics): number {
  const p = m.presentation_churn_share ?? 0;
  const x = Math.max(0, Math.min(1, (p - 0.4) / 0.4));
  const excess = x * x * (3 - 2 * x);
  const n = Math.max(0, m.presentation_pr_sample ?? 0);
  const concentration = Math.max(0, Math.min(1, m.presentation_repo_concentration ?? 0));
  const core = Math.max(0, m.presentation_core_pr_count ?? 0, m.core_impact_pr_count ?? 0);
  const coreShare = Math.max(0, Math.min(1, ((m.presentation_core_churn_share ?? 0) - 0.2) / 0.2));
  const churnProtection = 1 - coreShare * coreShare * (3 - 2 * coreShare);
  const protection = churnProtection / (1 + (Math.max(0, core - 3) / 5) ** 2);
  return 1 - 0.7 * excess * (0.5 + 0.5 * concentration) * n / (n + 2) * protection;
}

export function externalPrShare(m: RawMetrics): number {
  return Math.min(1, Math.max(0, m.external_merged_pr_count ?? 0) / Math.max(1, m.merged_pr_count));
}
export function ecosystemPresentationDiscount(m: RawMetrics): number {
  return 1 - (1 - presentationDiscount(m)) * externalPrShare(m);
}

export function prPresentationShare(pr: RecentPr): number | undefined {
  const files = pr.file_changes;
  if (!files?.length || files.length < pr.changed_files) return undefined;
  const total = files.reduce((s,f) => s + Math.max(0,f.additions) + Math.max(0,f.deletions),0);
  if (total <= 0) return undefined;
  const docSite = files.some(f => /(^|\/)docusaurus\.config\.[cm]?[jt]s$/.test(f.path));
  return files.reduce((s,f) => s + (isPresentationPath(f.path,pr.repo ?? "", docSite) ? Math.max(0,f.additions)+Math.max(0,f.deletions) : 0),0)/total;
}

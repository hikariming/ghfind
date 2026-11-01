"""Continuous presentation concentration; incomplete file samples stay neutral."""
import re

UI_LIBRARY = re.compile(r'(^|[-_./])(ui|design|design-system|components?|widgets?|styles?|css|themes?|antd|mui|chakra|shadcn|patternfly|tailwind(css)?)([-_./]|$)', re.I)
CORE_FILE = re.compile(r'\.(c|cc|cpp|cs|go|java|js|jsx|kt|m|mm|php|py|rb|rs|scala|swift|ts|tsx|vue|svelte|css|scss|sass|less|styl)$', re.I)
SITE = re.compile(r'(^|[-_./])(site|website|blog|docs?|homepage)([-_./]|$)|site$|\.github\.io$', re.I)

def is_presentation_path(path, repo, doc_site=False):
    p = path.lower()
    if re.search(r"\.(c|cc|cpp|cs|go|java|kt|m|mm|php|py|rb|rs|scala|swift)$", p):
        return False
    if re.search(r'(^|/)(server|backend|api|database|db|auth)(/|$)',p) and re.search(r'\.(jsx?|tsx?)$',p):
        return False
    if UI_LIBRARY.search(repo) and re.search(r'\.(css|scss|sass|less|styl)$', p):
        return False
    return bool(re.search(r'(^|/)(assets?|public|static)/.*(?:\.[a-z0-9_-]{6,}\.m?js|\.min\.js)$',p,re.I) or re.search(r'\.(md|mdx|rst|adoc|txt|svg|png|jpe?g|gif|webp|css|scss|sass|less|styl)$', p) or
        re.search(r'(^|/)(docs?|site|website|blog|content|articles|examples?|templates?|tutorials?|guides?|manual|i18n|locales?|__snapshots__|demos?|storybook|screenshots?)(/|$)', p) or
        re.search(r'(^|/)(readme|changelog|contributing|license)(\.[^/]*)?$', p) or
        re.search(r'(^|/)(pages/home|components/home[^/]*)(/|$)', p) or
        ((SITE.search(repo.rsplit('/', 1)[-1]) or doc_site) and not UI_LIBRARY.search(repo) and (re.search(r'\.(jsx?|tsx?|vue|svelte|astro|html)$', p) or re.search(r'(^|/)(package(-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|tsconfig\.json)$', p))))

def presentation_signals(prs, login, own_repos=(), own_shares=None):
    own_shares=own_shares or {}
    owned = {r.lower() for r in own_repos}
    churn = presentation = core_churn = n = core = 0
    by_repo = {}
    for pr in prs:
        repo = (pr.get('repo') or '').lower()
        if '/' not in repo or repo.split('/')[0] == login.lower():
            continue
        external=1-max(0,min(1,own_shares.get(repo,1))) if repo in owned else 1
        if external<=0: continue
        files = pr.get('file_changes') or []
        if not files or len(files) < pr.get('changed_files', 0):
            continue
        total = sum(max(0, f['additions']) + max(0, f['deletions']) for f in files)
        if total <= 0:
            continue
        doc_site = any(re.search(r'(^|/)docusaurus\.config\.[cm]?[jt]s$',f['path']) for f in files)
        amount = sum(max(0, f['additions']) + max(0, f['deletions']) for f in files if is_presentation_path(f['path'], repo, doc_site))
        core_churn += external*sum(max(0,f["additions"])+max(0,f["deletions"]) for f in files if CORE_FILE.search(f["path"]) and not is_presentation_path(f["path"],repo,doc_site))
        churn += external*total
        presentation += external*amount
        n += external
        if total > 5 and amount / total <= .4 and pr.get('repo_stars', 0) >= 200:
            core += external
        by_repo[repo] = by_repo.get(repo, 0) + external*amount
    return dict(presentation_core_churn_share=core_churn/churn if churn else 0, presentation_churn_share=presentation/churn if churn else 0,
                presentation_repo_concentration=sum(sorted(by_repo.values(), reverse=True)[:2])/presentation if presentation else 0,
                presentation_pr_sample=n, presentation_core_pr_count=core)

def presentation_discount(m):
    p = m.get('presentation_churn_share') or 0
    x = max(0, min(1, (p-.4)/.4))
    n = max(0, m.get('presentation_pr_sample') or 0)
    c = max(0, min(1, m.get('presentation_repo_concentration') or 0))
    core = max(0, m.get('presentation_core_pr_count') or 0, m.get('core_impact_pr_count') or 0)
    core_share = max(0,min(1,((m.get("presentation_core_churn_share") or 0)-.2)/.2))
    churn_protection = 1-core_share*core_share*(3-2*core_share)
    protection = churn_protection/(1+(max(0, core-3)/5)**2)
    return 1-.7*x*x*(3-2*x)*(.5+.5*c)*n/(n+2)*protection

def ecosystem_presentation_discount(m):
    share = min(1, max(0, m.get('external_merged_pr_count') or 0)/max(1,m['merged_pr_count']))
    return 1-(1-presentation_discount(m))*share

def pr_presentation_share(pr):
    files=pr.get('file_changes') or []
    if not files or len(files)<pr.get('changed_files',0): return None
    total=sum(max(0,f['additions'])+max(0,f['deletions']) for f in files)
    if total<=0: return None
    doc_site=any(re.search(r'(^|/)docusaurus\.config\.[cm]?[jt]s$',f['path']) for f in files)
    return sum(max(0,f['additions'])+max(0,f['deletions']) for f in files if is_presentation_path(f['path'],pr.get('repo') or '',doc_site))/total

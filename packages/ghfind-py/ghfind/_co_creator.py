"""Continuous leadership evidence; count alone never establishes authorship."""
import math
import re

def unit(x):
    return max(0, min(1, x))

def smooth(x):
    x = unit(x)
    return x*x*(3-2*x)

RECENT_MAINTENANCE_DAYS = 180
CONTENT_CHURN_PER_COMMIT = 100
CONTENT_ROLE_MAX = 0.35
ROLE_FADE = 0.2
INFLATION_STRENGTH = 5
SHARE_FADE = 0.15
REWRITE_WEIGHT = 0.1
CORE_FILE_CHURN_CAP = 1500
CONTRIBUTOR_PAGE_LIMIT = 3


def _nz(x):
    return max(0, x or 0)


def lifetime_dominance(f):
    commit_share = unit(f['user_commits']/max(1,f['total_commits']))
    rank = unit(f['user_commits']/max(1,f['leading_commits']))
    pr_share = unit(f['user_merged_prs']/max(1,f['total_merged_prs']))
    return .5*math.sqrt(commit_share)+.2*rank+.3*math.sqrt(pr_share)


def maintenance_dominance(f):
    """Current-maintainer dominance over the recent window (mirrors TS)."""
    rtc, rtp = _nz(f.get('recent_total_commits')), _nz(f.get('recent_total_merged_prs'))
    if rtc <= 0 and rtp <= 0:
        return 0
    rc = unit(_nz(f.get('recent_user_commits'))/max(1,rtc))
    rp = unit(_nz(f.get('recent_user_merged_prs'))/max(1,rtp))
    if rtc > 0 and rtp > 0:
        base = .6*math.sqrt(rc)+.4*math.sqrt(rp)
    elif rtc > 0:
        base = math.sqrt(rc)
    else:
        base = math.sqrt(rp)
    reviewed = _nz(f.get('reviewed_prs'))
    review = reviewed/(reviewed+20)
    volume = smooth(math.log1p(_nz(f.get('recent_user_commits'))+3*_nz(f.get('recent_user_merged_prs')))/math.log(61))
    return unit(base+.1*review)*volume


def content_role(f):
    churn = _nz(f.get('core_churn'))
    return min(CONTENT_ROLE_MAX, churn/(churn+CONTENT_CHURN_PER_COMMIT*max(1,f['total_commits'])))*smooth(_nz(f.get('substantive_samples'))/3)


def co_creator_share(f):
    substance = (1-math.exp(-_nz(f['core_churn'])/200))*smooth(_nz(f['substantive_samples'])/3)
    inflation = math.exp(-INFLATION_STRENGTH*unit(f.get('inflation_severity') or 0))
    if f.get('first_author'):
        return substance*smooth(math.log1p(_nz(f['user_commits'])+3*_nz(f['user_merged_prs']))/math.log(101))*inflation
    raw_role = max(lifetime_dominance(f), maintenance_dominance(f), content_role(f))
    role = raw_role*smooth(raw_role/ROLE_FADE)
    association = int(f.get('association') in ('OWNER','MEMBER','COLLABORATOR'))
    identity = min(1, .7+.1*association+.1*bool(f.get('release_author'))+.1*bool(f.get('maintainer_file'))+.05*bool(f.get('pinned')))
    counted = _nz(f['user_commits'])+3*_nz(f['user_merged_prs'])
    work = max(1-math.exp(-math.log1p(counted)/2), (1-math.exp(-_nz(f['core_churn'])/2000))*smooth(counted))
    tenure = .85+.15*(1-math.exp(-_nz(f['active_years'])/2))
    confidence = .6+.4*_nz(f['samples'])/(_nz(f['samples'])+2)
    share = unit(role*identity*work*tenure*substance*confidence*inflation)
    return share*smooth(share/SHARE_FADE)


_CORE_SOURCE = re.compile(r'\.(c|cc|cpp|cs|go|java|js|jsx|mjs|cjs|kt|php|py|rb|rs|scala|swift|ts|tsx|vue|svelte|css|scss)$')
_GENERATED_PATH = re.compile(r'(^|/)(vendor|vendored|third[_-]?party|node_modules|dist|build|out|generated|__generated__|gen)/|\.(min\.js|pb\.go|pb\.gw\.go|pb\.ts|g\.dart|freezed\.dart|generated\.\w+)$|_pb2(_grpc)?\.py$|\.d\.ts$')
_BOT_LOGIN = re.compile(r'\[bot\]$|-bot$|^(dependabot|renovate|github-actions|copilot-swe-agent)', re.I)


def weighted_core_churn(files, repo):
    """Content-weighted core churn for one PR/commit (mirrors TS weightedCoreChurn)."""
    from ._presentation import is_presentation_path
    core = total = fresh = 0
    for file in files:
        a, d = max(0, file['additions']), max(0, file['deletions'])
        churn = a+d
        total += churn
        if not _CORE_SOURCE.search(file['path']) or _GENERATED_PATH.search(file['path']) or is_presentation_path(file['path'], repo):
            continue
        rewrite = a >= 20 and d >= 20 and abs(a-d)/churn < 0.1
        capped = min(CORE_FILE_CHURN_CAP, churn)
        core += capped*(REWRITE_WEIGHT if rewrite else 1)
        fresh += 0 if rewrite else capped
    return core, total, fresh


def is_bot_login(login, kind=None):
    return kind == 'Bot' or bool(_BOT_LOGIN.search(login or ''))


def summarize_contributors(rows, login, truncated, history_total, fallback_user_commits):
    """Bots excluded from denominator and leader; truncated lists fall back to history totals."""
    lower = login.lower()
    human = bots = leading = 0
    user = None
    for row in rows:
        n = max(0, row.get('contributions') or 0)
        if is_bot_login(row.get('login'), row.get('type')):
            bots += n
            continue
        human += n
        leading = max(leading, n)
        if (row.get('login') or '').lower() == lower:
            user = (user or 0)+n
    history = max(0, history_total-bots)
    if user is None:
        user = max(0, fallback_user_commits) if (truncated or not rows) else 0
    total = max(human, history) if (truncated or human == 0) else human
    return dict(user_commits=user, total_commits=max(total, user), leading_commits=max(leading, user))


def project_share(repo):
    return unit(repo.get('attribution_share',1))

def budget_co_creator_shares(repos):
    total = sum(project_share(r) for r in repos if not (r.get("co_creator_facts") or {}).get("first_author"))
    factor = 2*math.tanh(total/2)/total if total > 0 else 1
    return [{**r,'attribution_share':project_share(r)*(1 if (r.get('co_creator_facts') or {}).get('first_author') else factor)} for r in repos]

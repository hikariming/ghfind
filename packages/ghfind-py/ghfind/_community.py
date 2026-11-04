"""Own-project community facts, mirrored from the TS/Go collectors."""
from ._co_creator import project_share
import math
import re
from datetime import datetime
from ._score import log_ratio, _math_round


def _days(value):
    try:
        return datetime.fromisoformat(value.replace('Z', '+00:00')).timestamp() / 86400
    except (ValueError, TypeError, AttributeError):
        return float('nan')


def _round4(value):
    return _math_round(value * 10000) / 10000


def _bot(login, kind):
    return not login or kind not in (None, 'User') or bool(re.search(
        r'\[bot\]$|-bot$|^bot-|^(renovate|dependabot|github-actions|greenkeeper|snyk-bot|codecov|allcontributors)', login, re.I))


def _established(profile, at, seen):
    if not profile:
        return False
    age = _days(at) - _days(profile.get('created_at'))
    return math.isfinite(age) and age >= 90 and (
        profile.get('followers', 0) >= 10 or profile.get('merged_prs', 0) - seen >= 3)


def compute_own_repo_community_facts(raw, ctx):
    from ._extract import is_doc_like_impact_pr
    login = ctx['login'].lower()
    orgs = {o.lower() for o in ctx['owner_orgs']}
    if ctx['attributed']:
        orgs.add(raw['repo'].split('/')[0].lower())
    mutual = {o.lower() for o in ctx['mutual_owners']}
    profiles = ctx['profiles']
    def profile(author):
        return profiles.get((author or '').lower())
    def insider(author):
        return any(o.lower() in orgs for o in (profile(author) or {}).get('orgs', []))
    seen = {}
    for pr in raw['merged']:
        if pr.get('author'):
            author = pr['author'].lower()
            seen[author] = seen.get(author, 0) + 1
    kept, trivial = [], 0
    outside = [pr for pr in raw['merged'] if not _bot(pr.get('author'), pr.get('author_type')) and pr['author'].lower() != login]
    for pr in outside:
        if insider(pr['author']) or not _established(profile(pr['author']), pr['created_at'], seen[pr['author'].lower()]):
            continue
        if pr['churn'] <= 5 or is_doc_like_impact_pr(dict(pr, repo=raw['repo'])):
            trivial += 1
        else:
            kept.append(pr)
    share = max(.5, len(kept) / (len(kept) + trivial)) if kept or trivial else .5
    contributors = {c['login'].lower(): dict(c) for c in raw['contributors']}
    for pr in outside:
        key = pr['author'].lower()
        contributors[key] = dict(login=pr['author'], type=pr.get('author_type') or 'User',
                                 contributions=max(contributors.get(key, {}).get('contributions', 0), seen[key]))
    weighted = sustained = top = user = 0
    for key, c in sorted(contributors.items()):
        if _bot(c['login'], c['type']):
            continue
        top = max(top, c['contributions'])
        if key == login:
            user = c['contributions']
            continue
        if insider(key) or not _established(profile(key), ctx['now'], seen.get(key, 0)):
            continue
        weighted += log_ratio(c['contributions'], 10) * (.5 if key in mutual else 1)
        sustained += c['contributions'] >= 5
    issues = [i for i in raw['issues'] if not _bot(i.get('author'), i.get('author_type'))
              and i['author'].lower() != login and not insider(i['author'])
              and _established(profile(i['author']), i['created_at'], 0)]
    demand = raw['issues_total'] * (len(issues) / len(raw['issues']) if raw['issues'] else 0)
    demand += raw['prs_opened_total'] * (len(kept) / len(raw['merged']) if raw['merged'] else 0)
    latencies = sorted(_days(p['merged_at']) - _days(p['created_at']) for p in kept)
    n = len(latencies)
    latency = (latencies[n // 2] if n % 2 else (latencies[n // 2 - 1] + latencies[n // 2]) / 2) if n else None
    now = _days(ctx['now'])
    answerable = [i for i in issues if now - _days(i['created_at']) > 3]
    answered = sum(login in [c.lower() for c in i['commenters']] for i in answerable)
    decided = raw['merged_total'] + raw['closed_unmerged_total']
    last = max((_days(p['merged_at']) for p in kept), default=None)
    return dict(weighted_contributors=_round4(weighted * share), sustained_contributors=sustained,
                outside_demand=_round4(demand), merge_latency_days=None if latency is None else _round4(latency),
                owner_response_share=_round4(answered / len(answerable)) if answerable else 0,
                outside_acceptance=_round4(raw['merged_total'] / decided) if decided else 0,
                forks=raw['forks'], outside_merged_prs=len(outside),
                days_since_outside_merge=_round4(max(0, now - last)) if last is not None else None,
                lead_share=(_round4(min(1, user / top)) if top else 0) if ctx['attributed'] else 1)


def own_repo_community(f):
    latency = f['merge_latency_days']
    latency_score = max(0, min(1, 1 - math.log10(max(latency, 1)) / math.log10(60))) if latency is not None else 0
    responsiveness = .5 * latency_score + .25 * f['owner_response_share'] + .25 * f['outside_acceptance']
    days = f['days_since_outside_merge']
    recency = .4 if days is None or days >= 730 else 1 if days <= 90 else 1 - .6 * ((days - 90) / 640)
    modulators = (log_ratio(f['sustained_contributors'], 10) + log_ratio(f['outside_demand'], 300)
                  + responsiveness + log_ratio(f['forks'], 1000)) / 4
    return _round4(max(0, min(1, f['lead_share'])) * recency * log_ratio(f['weighted_contributors'], 30) * (.6 + .4 * modulators))


def is_own_impact_repo(r, login):
    return r.get('attributed_original', False) or r['owner_login'].lower() == login


def impact_evidence_weight(r):
    facts = r.get('community_facts') or {}
    prs = max(0, facts.get('outside_merged_prs', 0))
    forks = max(0, r.get('forks', 0), facts.get('forks', 0))
    return 1 - math.exp(-2.6 * math.log1p(prs) - .6 * math.log1p(forks))


def impact_star_severity(r):
    facts = r.get('community_facts') or {}
    prs = max(0, facts.get('outside_merged_prs', 0))
    forks = max(0, r.get('forks', 0), facts.get('forks', 0))
    stars = max(0, r['stars'])
    return stars / (stars + 100) / ((1 + forks) ** 2 * (1 + 6 * prs) ** 2)


def impact_star_discount(r):
    severity = r.get('star_inflation_severity', .9 if r.get('star_inflation_suspect') else impact_star_severity(r))
    share = max(0, min(1, r.get("content_skill_share", 0)))
    return math.exp(-7 * max(0, min(1, severity))) * (1 - 0.75*share*share*(3-2*share))


def attributed_creator_weight(r, login):
    if not r.get('attributed_original'):
        return 0
    evidence = r.get('attribution_evidence', [])
    first = any(e.lower() == 'first commit author is ' + login for e in evidence)
    release = 'release/tag author' in evidence
    creator = 1 if first and release else .85 if first else .7 if release else 0
    return impact_evidence_weight(r) * creator * impact_star_discount(r)


def own_star_weight(stars):
    return 1 - math.exp(-math.log1p(max(0, stars) / 100))


def has_attributed_creator_star_credit(r, login):
    return attributed_creator_weight(r, login) > 0


def own_pr_community_share(repos, login, own_prs):
    if own_prs <= 0:
        return 0
    return _round4(max(0, min(1, sum(r['prs'] * project_share(r) * r.get('community', 0) for r in repos
        if is_own_impact_repo(r, login) and not r['is_fork'] and r.get('community', 0) > 0) / own_prs)))

"""Own-project community facts, mirrored from the TS/Go collectors."""
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
    from ._github import is_doc_like_impact_pr
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


def has_attributed_creator_star_credit(r, login):
    facts = r.get('community_facts') or {}
    return bool(r.get('attributed_original') and not r.get('star_inflation_suspect') and
                any(e == 'release/tag author' or e.lower() == 'first commit author is ' + login
                    for e in r.get('attribution_evidence', [])) and
                (facts.get('outside_merged_prs', 0) >= 1 or max(r.get('forks', 0), facts.get('forks', 0)) >= 10))


def own_pr_community_share(repos, login, own_prs):
    if own_prs <= 0:
        return 0
    return _round4(max(0, min(1, sum(r['prs'] * r.get('community', 0) for r in repos
        if is_own_impact_repo(r, login) and not r['is_fork'] and r.get('community', 0) > 0) / own_prs)))


def collect_own_repo_communities(repos, login, organizations, now):
    """Bounded best-effort samples; failed measurements remain absent, never invented."""
    from ._github import _graphql, _rest_get_opt, GitHubRateLimitError
    candidates = [r for r in repos if is_own_impact_repo(r, login.lower()) and not r['is_private']
                  and not r['is_fork'] and r['stars'] >= 200 and r['commits'] + r['prs'] > 0]
    counts = []
    for r in candidates:
        try:
            n = _graphql('query($q: String!) { search(query: $q, type: ISSUE, first: 0) { issueCount } }',
                         {'q': 'repo:' + r['repo'] + ' is:pr is:merged -author:' + login})['search']['issueCount']
            if n > 0:
                counts.append((r, n))
        except GitHubRateLimitError:
            raise
        except Exception:
            continue
    profiles = {}
    mutual = sorted({r['owner_login'].lower() for r in repos if not is_own_impact_repo(r, login.lower()) and r['commits'] + r['prs'] > 0})
    for r, _ in sorted(counts, key=lambda item: (-item[1], -item[0]['stars'], item[0]['repo']))[:3]:
        try:
            owner, name = r['repo'].split('/', 1)
            def query(filter_):
                return 'repo:' + r['repo'] + ' ' + filter_ + ' -author:' + login
            data = _graphql('''query($o: String!, $n: String!, $m: String!, $i: String!, $c: String!, $p: String!) {
              repository(owner: $o, name: $n) { forkCount }
              merged: search(query: $m, type: ISSUE, first: 60) { issueCount nodes { ... on PullRequest {
                createdAt mergedAt title additions deletions files(first: 15) { nodes { path } } author { __typename login }
              } } }
              issues: search(query: $i, type: ISSUE, first: 30) { issueCount nodes { ... on Issue {
                createdAt author { __typename login } comments(first: 20) { nodes { author { login } } }
              } } }
              closed: search(query: $c, type: ISSUE, first: 0) { issueCount }
              opened: search(query: $p, type: ISSUE, first: 0) { issueCount }
            }''', dict(o=owner, n=name, m=query('is:pr is:merged sort:created-desc'), i=query('is:issue sort:created-desc'),
                       c=query('is:pr is:closed is:unmerged'), p=query('is:pr')))
            contributors = [dict(login=c['login'], type=c.get('type', 'User'), contributions=c.get('contributions', 0))
                            for c in (_rest_get_opt('repos/' + r['repo'] + '/contributors?per_page=100') or []) if c.get('login')]
            merged = [dict(author=(p.get('author') or {}).get('login'), author_type=(p.get('author') or {}).get('__typename'),
                           created_at=p['createdAt'], merged_at=p['mergedAt'], title=p.get('title'),
                           churn=p.get('additions', 0) + p.get('deletions', 0), files=[f['path'] for f in (p.get('files') or {}).get('nodes', [])])
                      for p in data['merged']['nodes'] if p and p.get('mergedAt') and p.get('createdAt')]
            issues = [dict(author=(i.get('author') or {}).get('login'), author_type=(i.get('author') or {}).get('__typename'),
                           created_at=i['createdAt'], commenters=[c['author']['login'] for c in (i.get('comments') or {}).get('nodes', []) if c and c.get('author')])
                      for i in data['issues']['nodes'] if i and i.get('createdAt')]
            authors = {c['login'].lower() for c in contributors if not _bot(c['login'], c['type'])}
            authors.update(p['author'].lower() for p in merged + issues if not _bot(p['author'], p['author_type']))
            for author in sorted(authors - {login.lower()} - set(profiles)):
                profile = _graphql('''query($l: String!) { user(login: $l) { createdAt followers { totalCount }
                    pullRequests(states: MERGED) { totalCount } organizations(first: 10) { nodes { login } } } }''', {'l': author}).get('user')
                if profile:
                    profiles[author] = dict(created_at=profile['createdAt'], followers=profile['followers']['totalCount'],
                                            merged_prs=profile['pullRequests']['totalCount'], orgs=[o['login'] for o in profile['organizations']['nodes'] if o])
            raw = dict(repo=r['repo'], forks=(data.get('repository') or {}).get('forkCount', 0), merged_total=data['merged']['issueCount'],
                       closed_unmerged_total=data['closed']['issueCount'], prs_opened_total=data['opened']['issueCount'],
                       issues_total=data['issues']['issueCount'], contributors=contributors, merged=merged, issues=issues)
            facts = compute_own_repo_community_facts(raw, dict(login=login, owner_orgs=organizations,
                attributed=bool(r.get('attributed_original')), mutual_owners=mutual, profiles=profiles, now=now.isoformat()))
            r['community_facts'] = facts
            r['community'] = 0 if r.get('star_inflation_suspect') else own_repo_community(facts)
        except GitHubRateLimitError:
            raise
        except Exception:
            continue

#!/usr/bin/env python3
"""Corpus of real classifier inputs with collect.py's outputs, for the TypeScript port's parity
check (src/lib/devscore/collect/classify.ts; scripts/devscore-classify-parity.mts).

    python3 scripts/devscore-classify-corpus.py <devscore dir> [--max-files N] [--per-fn N] [--seed S]

Reads inputs from <devscore dir>/data/*.json, <set>/data/*.json and the collector's response
cache (collector/.cache, up to --max-files cached bodies), runs every pure collect.py function
on them and prints {"cases": [[fn, args, output], ...]} (JSON; tuples as lists). --per-fn caps
the cases per function (random sample with --seed) for the small checked-in fixture.
"""
from __future__ import annotations

import argparse
import glob
import json
import os
import random
import sys


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("devscore")
    ap.add_argument("--max-files", type=int, default=60000)
    ap.add_argument("--per-fn", type=int, default=0)
    ap.add_argument("--seed", type=int, default=1)
    a = ap.parse_args()
    sys.path.insert(0, os.path.join(a.devscore, "collector"))
    import collect as C  # noqa: E402

    rng = random.Random(a.seed)
    cases: dict[str, list] = {}
    seen: dict[str, set] = {}

    def add(fn: str, args: list, out) -> None:
        key = json.dumps(args, sort_keys=False)
        if key in seen.setdefault(fn, set()):
            return
        seen[fn].add(key)
        cases.setdefault(fn, []).append([fn, args, out])

    paths: set[str] = set()
    titles: set[str] = set()
    logins: set[str] = set()

    # ---- data files: output repo records
    files = sorted(glob.glob(os.path.join(a.devscore, "data", "*.json")) +
                   glob.glob(os.path.join(a.devscore, "*", "data", "*.json")))
    for f in files:
        try:
            d = json.load(open(f))
        except (OSError, ValueError):
            continue
        if not isinstance(d, dict) or not isinstance(d.get("repos"), list):
            continue
        login = d.get("login") or ""
        logins.add(login)
        repos = [r for r in d["repos"] if isinstance(r, dict) and r.get("name")]
        cand = [{k: r.get(k) for k in ("name", "is_fork", "stars", "owned", "user_rank", "repo_total_commits",
                                        "user_commits")} for r in repos]
        add("star_history_candidates", [cand], C.star_history_candidates(cand))
        for r in repos:
            sample = r.get("commit_sample")
            for kind in ("code", "content", "site"):
                if sample is not None or kind == "code":
                    s = [{"kind": c["kind"], "substance": c["substance"]} for c in sample or []] or None
                    add("kind_with_evidence", [kind, r["name"], s], C.kind_with_evidence(kind, r["name"], s))
            add("package_names", [r["name"]], C.package_names(r["name"]))
            pk = r.get("pr_kinds")
            if isinstance(pk, dict) and sum(v or 0 for v in pk.values()):
                counts = {k: v or 0 for k, v in pk.items()}
                n = sum(counts.values())
                for total in (n, n + 1, n * 3 + 2, n * 7 + 5):
                    add("scale_counts", [counts, total], C.scale_counts(counts, total))
            m = r.get("pr_mergers")
            if isinstance(m, dict) and m:
                add("maint_months", [m], C.maint_months(m))

    # ---- cached responses
    cache = os.path.join(a.devscore, "collector", ".cache")
    names = sorted(os.listdir(cache)) if os.path.isdir(cache) else []
    rng.shuffle(names)
    mergers_by_user: dict[str, dict] = {}
    for name in names[:a.max_files]:
        try:
            body = json.load(open(os.path.join(cache, name))).get("body") or ""
            d = json.loads(body)
        except (OSError, ValueError, AttributeError):
            continue
        if isinstance(d, list):
            if d and all(isinstance(p, dict) and "repository_url" in p for p in d[:3]):
                urls = [p.get("repository_url") for p in d if isinstance(p, dict)]
                for u in urls[:5]:
                    add("_norm_repo_url", [u], C._norm_repo_url(u))
                    add("_github_owner", [u], C._github_owner(u))
                u0 = C._norm_repo_url(urls[0]) if urls else ""
                parts = u0.split("github.com/", 1)[1].split("/") if "github.com/" in u0 else []
                if len(parts) >= 2:
                    repo = f"{parts[0]}/{parts[1]}"
                    slim = [{k: p.get(k) for k in ("name", "repository_url", "dependent_packages_count",
                                                   "dependent_repos_count")} for p in d[:20] if isinstance(p, dict)]
                    add("package_dependents", [repo, slim, []], list(C.package_dependents(repo, slim, [])))
                    add("package_dependents", [repo, None, [slim]], list(C.package_dependents(repo, None, [slim])))
                    other = parts[0] + "/other-" + parts[1]
                    add("package_dependents", [other, [], [slim, None]], list(C.package_dependents(other, [], [slim, None])))
            continue
        if not isinstance(d, dict):
            continue
        # REST commit
        if isinstance(d.get("files"), list) and isinstance(d.get("commit"), dict):
            msg = d["commit"].get("message") or ""
            fl = [{"filename": f.get("filename"), "additions": f.get("additions"), "deletions": f.get("deletions")}
                  for f in d["files"] if isinstance(f, dict)]
            parents = len(d.get("parents") or [])
            add("classify_commit", [msg, parents, fl], C.classify_commit(msg, parents, fl))
            sub = [{"path": f["filename"], "additions": f["additions"], "deletions": f["deletions"]} for f in fl]
            add("pr_substance", [sub], C.pr_substance(sub))
            titles.add(msg.split("\n", 1)[0])
            paths.update(f["filename"] for f in fl if f["filename"])
            continue
        data = d.get("data")
        if not isinstance(data, dict):
            continue
        user = data.get("user")
        if isinstance(user, dict) and isinstance(user.get("pullRequests"), dict):
            login = user.get("login") or ""
            nodes = [n for n in user["pullRequests"].get("nodes") or [] if isinstance(n, dict)]
            by_repo: dict[str, list] = {}
            for n in nodes:
                if n.get("title"):
                    titles.add(n["title"])
                repo = (n.get("repository") or {}).get("nameWithOwner")
                if repo:
                    by_repo.setdefault(repo, []).append(n)
            for login_guess in {login, *(n["mergedBy"]["login"] for n in nodes[:3] if n.get("mergedBy"))}:
                for repo, ns in by_repo.items():
                    prs = {str(i): {"mergedBy": n.get("mergedBy")} for i, n in enumerate(ns)}
                    mg = C.pr_mergers(prs, login_guess)
                    add("pr_mergers", [prs, login_guess], mg)
                    if mg:
                        mergers_by_user.setdefault(login_guess, {})[repo] = mg
            continue
        for alias, v in data.items():
            if not isinstance(v, dict):
                continue
            if "nameWithOwner" in v:  # repo meta
                nwo = v["nameWithOwner"]
                owner = nwo.split("/", 1)[0]
                entries = (v.get("object") or {}).get("entries")
                wf = (v.get("workflows") or {}).get("entries")
                desc = v.get("description")
                for login in (owner, nwo.split("/", 1)[1], "someone"):
                    add("repo_kind", [nwo, login, desc, entries], C.repo_kind(nwo, login, desc, entries))
                add("repo_kind", [nwo, "someone", desc, None], C.repo_kind(nwo, "someone", desc, None))
                add("is_content_tree", [entries], C.is_content_tree(entries))
                add("has_ci", [entries, wf], C.has_ci(entries, wf))
                add("has_ci", [None, wf], C.has_ci(None, wf))
                add("has_tests", [entries], C.has_tests(entries))
                if isinstance(v.get("forkCount"), int):
                    for commits in (0, 1, 7, 150, 4000):
                        meta = {"forkCount": v["forkCount"]}
                        add("repo_priority", [meta, commits], C.repo_priority(meta, commits))
                        add("pr_sample_priority", [meta, commits, commits // 3 + 2],
                            C.pr_sample_priority(meta, commits, commits // 3 + 2))
                for e in entries or []:
                    paths.add(e["name"])
            elif "issues" in v and "owner" in v:  # repo signals
                owner = (v.get("owner") or {}).get("login") or ""
                inodes = (v.get("issues") or {}).get("nodes") or []
                authors = [((n or {}).get("author") or {}).get("login") for n in inodes]
                for login in {"someone", *[x for x in authors[:2] if x]}:
                    add("issue_authors", [inodes, owner, login], C.issue_authors(inodes, owner, login))
            elif "issueCount" in v:  # per-repo merged PR sample
                nodes = [n for n in v.get("nodes") or [] if isinstance(n, dict)]
                for n in nodes:
                    if n.get("title"):
                        titles.add(n["title"])
                add("pr_batch_share", [nodes], C.pr_batch_share(nodes))
                for n in nodes[:3]:
                    for login in ("someone", ((n.get("mergedBy") or {}).get("login") or "x")):
                        add("merger_key", [n, login], C.merger_key(n, login))
            elif isinstance(v.get("pullRequest"), dict):  # PR details
                pr = v["pullRequest"]
                nodes = (pr.get("files") or {}).get("nodes") or []
                add("pr_substance", [nodes], C.pr_substance(nodes))
                fps = [f["path"] for f in nodes]
                paths.update(fps)
                for t in rng.sample(sorted(titles), min(2, len(titles))) if titles else [""]:
                    for kind in ("code", "site", "data"):
                        add("classify_pr", [t, fps, kind], C.classify_pr(t, fps, kind))

    # ---- mutual merger pairs per user (from the mergers built above)
    for login, mg in mergers_by_user.items():
        ext = {r: m for r, m in mg.items() if r.split("/", 1)[0].lower() != login.lower()}
        counts = {r: sum(m.values()) + (len(r) % 3) for r in ext}
        add("mutual_merger_pairs", [ext, counts], [list(p) for p in C.mutual_merger_pairs(ext, counts)])

    # ---- adversarial variants for the regex translation: case, Unicode, trailing newlines
    def mutate(s: str) -> list[str]:
        return [s.upper(), s + "\n", s + "\n\n", "İ" + s.replace("i", "ı"), "修" + s, s.replace(" ", "\u3000"),
                s.replace("-", "é"), s.replace("/", "/\n")]
    for p in rng.sample(sorted(paths), min(3000, len(paths))):
        paths.update(mutate(p))
    for t in rng.sample(sorted(titles), min(3000, len(titles))):
        titles.update(mutate(t))
    for nwo in ("a/my-website", "a/docs-İo", "a/WIKI", "a/dotfiles\n", "a/b_config", "a/talk-ı", "a/awesome-x",
                "a/Site", "a/nvimrc", "a/x.github.io", "a/slıdes", "a/book\n"):
        for desc in (None, "My personal website", "slides from JSConf", "source of the ünı site", "docs site\n",
                     "used to build foo.İo", "official\u3000site", "talk at x"):
            add("repo_kind", [nwo, "someone", desc, None], C.repo_kind(nwo, "someone", desc, None))
    for n in ("a/node-foo-js", "a/py-ı-rust", "a/PY-bar", "a/go-x\n", "a/xy-go", "a/pythonic"):
        add("package_names", [n], C.package_names(n))
    for u in (" https://GitHub.com/A/B.git/ ", "\u3000github.com/x/y\u3000", "www.github.com/o/r/", "github.com/o",
              "http://github.com/Ö/r.git"):
        add("_norm_repo_url", [u], C._norm_repo_url(u))
        add("_github_owner", [u], C._github_owner(u))
    ents = [{"name": n, "type": t, "extension": e} for n, t, e in
            [("foo_test.GO", "blob", ".GO"), ("TEST_x.PY", "blob", ".PY"), ("Tests", "tree", ""), ("Jenkinsfile", "blob", ""),
             ("x_test.", "blob", ""), ("tı_test.c\n", "blob", ".c")]]
    for i in range(len(ents)):
        add("has_tests", [ents[i:i + 1]], C.has_tests(ents[i:i + 1]))
        add("has_ci", [ents[i:i + 1], None], C.has_ci(ents[i:i + 1], None))

    # ---- paths and titles
    for p in sorted(paths):
        add("file_kind", [p], C.file_kind(p))
        add("core_area", [p], C.core_area(p))
    for t in sorted(titles):
        for kind in ("code", "site", "data"):
            add("classify_pr", [t, None, kind], C.classify_pr(t, None, kind))
        add("classify_commit", [t, 1, []], C.classify_commit(t, 1, []))

    # ---- months and gap series (synthetic: the inputs are ClickHouse monthly totals)
    for m in ("2020-01", "2024-12", "2025-06", "1999-11"):
        for k in (-25, -13, -12, -1, 0, 1, 11, 12, 13, 30):
            add("_month_add", [m, k], C._month_add(m, k))
    for ts in ("2024-03-05T10:00:00Z", "2019-12-31"):
        add("month_key", [ts], C.month_key(ts))
    for _ in range(300):
        start = f"{rng.randint(2012, 2022)}-{rng.randint(1, 12):02d}"
        n = rng.randint(1, 40)
        months = [C._month_add(start, i) for i in range(n)]
        rng.shuffle(months)
        rate = {m: (0.0 if rng.random() < 0.1 else round(rng.uniform(0, 100) * (0.2 if rng.random() < 0.15 else 1), 3))
                for m in months}
        add("_gap_series", [rate], C._gap_series(rate))
        add("maint_months", [{m: int(v) % 7 for m, v in rate.items()}], C.maint_months({m: int(v) % 7 for m, v in rate.items()}))
    for _ in range(300):
        counts = {k: rng.randint(0, 9) for k in rng.sample(["core", "test", "docs", "site", "chore", "merge", "data"], rng.randint(1, 7))}
        if not sum(counts.values()):
            continue
        total = sum(counts.values()) + rng.randint(0, 60)
        add("scale_counts", [counts, total], C.scale_counts(counts, total))
    for _ in range(200):
        days = [f"2024-0{rng.randint(1, 3)}-1{rng.randint(0, 3)}T12:00:00Z" for _ in range(rng.randint(0, 12))]
        nodes = [{"number": rng.randint(1, 10), "mergedAt": d if rng.random() < 0.9 else None} for d in days]
        add("pr_batch_share", [nodes], C.pr_batch_share(nodes))

    out = []
    for fn in sorted(cases):
        cs = cases[fn]
        if a.per_fn and len(cs) > a.per_fn:
            # fixture: cases of ≤ 600 JSON chars (else the smallest), half of them non-ASCII where any
            by_size = sorted(cs, key=lambda c: len(json.dumps(c[1])))
            small = [c for c in by_size if len(json.dumps(c[1])) <= 600] or by_size[:a.per_fn]
            wide = [c for c in small if not json.dumps(c[1], ensure_ascii=False).isascii()]
            take = rng.sample(wide, min(len(wide), a.per_fn // 2))
            rest = [c for c in small if c not in take]
            cs = take + rng.sample(rest, min(len(rest), a.per_fn - len(take)))
        out += cs
    json.dump({"cases": out}, sys.stdout, ensure_ascii=False, separators=(",", ":"))


if __name__ == "__main__":
    main()

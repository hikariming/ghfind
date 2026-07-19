"""Deterministic 0-100 value/trust scorer — faithful Python port of the website's
``src/lib/score.ts`` (itself a port of the canonical Python skill).

The number is the single source of truth; the LLM only writes prose/roast on top
of this output.

Parity notes (why this reproduces the TS output bit-for-bit):
- TS reimplemented Python's ``round()`` (round-half-to-even / banker's) as its own
  ``round()``. Python's built-in ``round()`` IS banker's, so we use it directly for
  every TS ``round(...)`` call.
- TS ``Math.round(...)`` is round-half-UP, NOT banker's. We replicate it with
  ``_math_round`` = ``floor(x + 0.5)`` wherever the TS uses ``Math.round``.
- ``??`` (nullish) defaults only on null/undefined; ``_nz`` mirrors that (defaults
  only on ``None``), so an explicit 0/False is preserved.
"""

from __future__ import annotations

import math
from typing import Any, Dict, List, Mapping, Optional

SUBSCORE_MAX: Dict[str, float] = {
    "account_maturity": 10,
    "original_project_quality": 18,
    "contribution_quality": 27,
    "ecosystem_impact": 20,
    "community_influence": 8,
    "activity_authenticity": 17,
}


def _nz(value: Any, default: Any) -> Any:
    """Mirror TS ``value ?? default`` — default only when value is None."""
    return default if value is None else value


def _math_round(x: float) -> int:
    """Mirror JS ``Math.round`` (round half up toward +Inf). Inputs here are >= 0."""
    return math.floor(x + 0.5)


def log_ratio(value: float, full_at: float) -> float:
    """0..1 scaled with a log curve: returns 1.0 when value >= full_at."""
    if value <= 0:
        return 0.0
    return min(math.log10(value + 1) / math.log10(full_at + 1), 1.0)


def clamp_score(value: float) -> float:
    """Clamp a score to [0, 100] and round to 2 decimals (banker's)."""
    return round(max(0, min(value, 100)), 2)


def spam_bot_score(m: Mapping[str, Any]) -> float:
    """Hidden 0-10 spam-PR / bot likelihood. Deterministic from the metrics.

    Not part of the public scoring payload (kept for completeness / parity).
    """
    s = 0.0

    if _nz(m.get("pr_flood_suspect"), False):
        share = _nz(m.get("top_repo_pr_share"), 0)
        templated = _nz(m.get("templated_pr_ratio"), 0)
        sev = max(0.0, min(1.0, ((share - 0.5) / 0.5) * 0.5 + ((templated - 0.5) / 0.5) * 0.5))
        s += 3 + 4 * sev

    merged_sample = _nz(m.get("recent_merged_pr_sample"), 0)

    ext_trivial_ratio = (_nz(m.get("external_trivial_pr_count"), 0) / merged_sample) if merged_sample > 0 else 0
    if merged_sample >= 8 and ext_trivial_ratio > 0.3:
        s += min(4, ((ext_trivial_ratio - 0.3) / 0.6) * 4)

    if m.get("maintainer_closed_unmerged_pr_count") is not None:
        rejected = m.get("maintainer_closed_unmerged_pr_count")
    elif m.get("self_closed_external_pr_count") is None and m.get("self_closed_own_repo_pr_count") is None:
        rejected = _nz(m.get("closed_unmerged_pr_count"), 0)
    else:
        rejected = 0
    rejected = _nz(rejected, 0)
    decided = m["merged_pr_count"] + rejected
    if decided >= 10 and _nz(m.get("pr_rejection_rate"), 0) > 0.5:
        s += min(2, ((_nz(m.get("pr_rejection_rate"), 0) - 0.5) / 0.5) * 2)

    if m["following"] > 1000 and m["followers"] < m["following"] * 0.3:
        s += 2
    if m["account_age_years"] < 1 and m["public_repos"] > 30:
        s += 1.5
    fetched = max(m["fetched_repo_count"], 1)
    if m["fork_repo_count"] / fetched > 0.7 and m["nonempty_original_repo_count"] <= 2:
        s += 1.5
    if not m.get("bio") and m["followers"] < 3 and m["total_stars"] == 0 and m["merged_pr_count"] < 2:
        s += 1

    return _math_round(max(0.0, min(s, 10)) * 10) / 10


def _doc_like_ratio(m: Mapping[str, Any]) -> tuple:
    sample = _nz(m.get("recent_external_pr_sample"), _nz(m.get("recent_merged_pr_sample"), 0))
    if m.get("recent_external_doc_like_pr_ratio") is not None:
        ratio = m["recent_external_doc_like_pr_ratio"]
    elif m.get("recent_doc_like_pr_ratio") is not None:
        ratio = m["recent_doc_like_pr_ratio"]
    elif sample > 0 and m.get("recent_external_doc_like_pr_count") is not None:
        ratio = m["recent_external_doc_like_pr_count"] / sample
    elif sample > 0 and m.get("recent_doc_like_pr_count") is not None:
        ratio = m["recent_doc_like_pr_count"] / sample
    else:
        ratio = 0
    return sample, ratio


def doc_like_pr_volume_discount(m: Mapping[str, Any], pr_volume: float) -> float:
    sample, ratio = _doc_like_ratio(m)
    if sample < 20 or ratio < 0.55:
        return 0
    severity = max(0.0, min(1.0, (ratio - 0.55) / 0.075))
    return min(pr_volume * 0.55, 2.5 + severity * 3.0)


def contribution_quality_cap(m: Mapping[str, Any]) -> Optional[float]:
    sample, ratio = _doc_like_ratio(m)
    if sample < 20 or ratio < 0.55:
        return None
    low_trust_impact = (
        m.get("impact_quality_cap") is not None
        and m["impact_quality_cap"] <= 4
        and _nz(m.get("core_impact_pr_count"), 0) <= 2
    )
    weak_top_star_project = (
        _nz(m.get("top_starred_original_repo_quality_score"), 1) < 0.3 and m["total_stars"] > 0
    )
    self_closed_external = _nz(m.get("self_closed_external_pr_count"), 0)
    total_externalish = (
        m["merged_pr_count"] + _nz(m.get("maintainer_closed_unmerged_pr_count"), 0) + self_closed_external
    )
    heavy_self_closed_external = (
        total_externalish >= 20 and self_closed_external / total_externalish >= 0.25
    )
    weak_own_project_signal = (
        m["max_stars"] < 100
        and m["total_stars"] < 300
        and _nz(m.get("top_starred_original_repo_quality_score"), 1) < 0.6
    )
    if low_trust_impact and (weak_top_star_project or weak_own_project_signal or heavy_self_closed_external):
        return 12
    return None


def high_impact_core_pr_bonus(m: Mapping[str, Any]) -> float:
    core = _nz(m.get("core_impact_pr_count"), 0)
    star_signal = impact_prestige_signal(m)
    if core < 2 or star_signal < 0.5:
        return 0
    core_signal = min(core / 5, 1)
    return min(2, star_signal * 0.8 + core_signal * 1.2)


def impact_prestige_signal(m: Mapping[str, Any]) -> float:
    return max(
        0.0,
        min(
            _nz(m.get("impact_prestige_score"), log_ratio(m["max_impact_repo_stars"], 100_000)),
            1.0,
        ),
    )


def low_prestige_bulk_contribution_cap(m: Mapping[str, Any]) -> Optional[float]:
    if m["merged_pr_count"] < 80:
        return None
    if impact_prestige_signal(m) >= log_ratio(10_000, 100_000):
        return None
    if m["max_stars"] >= 1000:
        return None
    return 22


def templated_pr_flood_penalty(m: Mapping[str, Any]) -> Optional[int]:
    if not _nz(m.get("pr_flood_suspect"), False):
        return None

    share = _nz(m.get("top_repo_pr_share"), 0)
    templated = _nz(m.get("templated_pr_ratio"), 0)
    concentration_severity = max(
        0.0,
        min(1.0, ((share - 0.5) / 0.5) * 0.5 + ((templated - 0.5) / 0.5) * 0.5),
    )
    sample = _nz(m.get("recent_merged_pr_sample"), _nz(m.get("recent_pr_sample"), 0))
    if m.get("recent_external_doc_like_pr_ratio") is not None:
        doc_like_ratio = m["recent_external_doc_like_pr_ratio"]
    elif m.get("recent_doc_like_pr_ratio") is not None:
        doc_like_ratio = m["recent_doc_like_pr_ratio"]
    elif sample > 0 and m.get("recent_external_doc_like_pr_count") is not None:
        doc_like_ratio = m["recent_external_doc_like_pr_count"] / sample
    elif sample > 0 and m.get("recent_doc_like_pr_count") is not None:
        doc_like_ratio = m["recent_doc_like_pr_count"] / sample
    else:
        doc_like_ratio = 0
    rejection = _nz(m.get("pr_rejection_rate"), 0)
    has_popular_impact_signal = (
        _nz(m.get("impact_pr_count"), 0) > 0
        or _nz(m.get("max_impact_repo_stars"), 0) >= 10_000
    )
    low_core_impact = (
        has_popular_impact_signal
        and _nz(m.get("core_impact_pr_count"), 0) <= 2
        and (m.get("impact_quality_cap") is not None or _nz(m.get("max_impact_repo_stars"), 0) >= 10_000)
    )
    weak_own_project = (
        m["total_stars"] < 300
        and _nz(m.get("top_starred_original_repo_quality_score"), 1) < 0.5
    )
    low_quality_evidence = (
        (1 if sample >= 20 and doc_like_ratio >= 0.55 else 0)
        + (1 if rejection >= 0.35 else 0)
        + (1 if low_core_impact else 0)
        + (1 if weak_own_project else 0)
    )
    extreme_flood = share >= 0.85 and templated >= 0.75

    if low_quality_evidence >= 2 or (extreme_flood and low_quality_evidence >= 1):
        return 10 + _math_round(10 * concentration_severity)
    if low_quality_evidence == 1 or extreme_flood:
        return 6 + _math_round(4 * concentration_severity)
    return 4 + _math_round(4 * concentration_severity)


def author_self_closed_external_penalty(m: Mapping[str, Any]) -> float:
    return 0


def _has_social_only_dormant_signal(m: Mapping[str, Any]) -> bool:
    best_project_quality = _nz(m.get("best_original_repo_quality_score"), 0)
    return (
        m["followers"] >= 500
        and m["last_year_contributions"] == 0
        and m["merged_pr_count"] == 0
        and _nz(m.get("impact_pr_count"), 0) == 0
        and _nz(m.get("max_impact_repo_stars"), 0) == 0
        and m["total_stars"] <= 300
        and best_project_quality < 0.85
    )


def tier_for(final: float) -> Dict[str, str]:
    if final >= 90:
        return {"tier": "夯", "tier_label": "封神 · 殿堂级标杆"}
    if final >= 80:
        return {"tier": "顶级", "tier_label": "顶级开发者 · 一线水准"}
    if final >= 70:
        return {"tier": "人上人", "tier_label": "优质贡献者 · 值得信任"}
    if final >= 40:
        return {"tier": "NPC", "tier_label": "普通账号 · 特征平庸存疑"}
    return {"tier": "拉完了", "tier_label": "低价值 · 疑似刷量/AI 机器人"}


_TIER_THRESHOLDS = [
    {"threshold": 40, "tier": "NPC"},
    {"threshold": 70, "tier": "人上人"},
    {"threshold": 80, "tier": "顶级"},
    {"threshold": 90, "tier": "夯"},
]


def next_tier(final: float) -> Optional[Dict[str, Any]]:
    for t in _TIER_THRESHOLDS:
        if final < t["threshold"]:
            return t
    return None


def score(m: Mapping[str, Any]) -> Dict[str, Any]:
    sub: Dict[str, float] = {
        "account_maturity": 0,
        "original_project_quality": 0,
        "contribution_quality": 0,
        "ecosystem_impact": 0,
        "community_influence": 0,
        "activity_authenticity": 0,
    }

    # 1. Account Maturity (10)
    age_pts = min(m["account_age_years"] / 6.0, 1.0) * 7
    years = m["contribution_years_active"]
    span_pts = 0 if years == 0 else 1 if years == 1 else 2 if years == 2 else 3
    sub["account_maturity"] = round(age_pts + span_pts, 1)

    # 2. Original Project Quality (18)
    if m["nonempty_original_repo_count"] == 0:
        sub["original_project_quality"] = 0.0
    else:
        star_quality = (
            max(0, min(_nz(m.get("top_starred_original_repo_quality_score"), 1), 1))
            if m["total_stars"] > 0
            else 1
        )
        star_pts = (log_ratio(m["total_stars"], 5000) * 7 + log_ratio(m["max_stars"], 2000) * 5) * star_quality
        project_substance = max(0, min(_nz(m.get("best_original_repo_quality_score"), 0), 1)) * 6
        sub["original_project_quality"] = round(star_pts + project_substance, 1)

    # 3. Contribution Quality (27)
    pr_volume_raw = log_ratio(m["merged_pr_count"], 200) * 16
    pr_volume = max(0, pr_volume_raw - doc_like_pr_volume_discount(m, pr_volume_raw))
    has_closed_pr_breakdown = (
        m.get("maintainer_closed_unmerged_pr_count") is not None
        or m.get("self_closed_external_pr_count") is not None
        or m.get("self_closed_own_repo_pr_count") is not None
    )
    if has_closed_pr_breakdown:
        acceptance_total = max(
            m["merged_pr_count"],
            m["merged_pr_count"] + _nz(m.get("maintainer_closed_unmerged_pr_count"), 0),
        )
    else:
        acceptance_total = max(m["merged_pr_count"], m["total_pr_count"])
    if acceptance_total >= 3:
        acceptance = (m["merged_pr_count"] / acceptance_total) * 6
    else:
        acceptance = m["merged_pr_count"] * 1.2
    acceptance = min(acceptance, 6.0)
    issue_pts = log_ratio(m["issues_created"], 100) * 5
    contribution_quality_raw = (
        pr_volume
        + acceptance
        + issue_pts
        + high_impact_core_pr_bonus(m)
        - author_self_closed_external_penalty(m)
    )
    contribution_cap = min(
        contribution_quality_cap(m) if contribution_quality_cap(m) is not None else math.inf,
        low_prestige_bulk_contribution_cap(m) if low_prestige_bulk_contribution_cap(m) is not None else math.inf,
        SUBSCORE_MAX["contribution_quality"],
    )
    sub["contribution_quality"] = round(min(contribution_quality_raw, contribution_cap), 1)

    # 4. Ecosystem & Maintainer Impact (20)
    prestige = impact_prestige_signal(m) * 9
    depth = min(m["impact_depth_raw"] / 8.0, 1.0) * 11
    ecosystem_raw = prestige + depth
    sub["ecosystem_impact"] = round(
        ecosystem_raw if m.get("impact_quality_cap") is None else min(ecosystem_raw, m["impact_quality_cap"]),
        1,
    )

    # 5. Community Influence (8)
    follower_pts = log_ratio(m["followers"], 2000) * 5
    following = m["following"]
    followers = m["followers"]
    if following > 2000 and followers < following * 0.3:
        ratio_pts = 0.0
    elif following == 0:
        ratio_pts = 3.0 if followers > 0 else 0.0
    else:
        ratio = followers / following
        ratio_pts = 3 if ratio >= 2 else 2 if ratio >= 1 else 1.5 if ratio >= 0.5 else 1
    community_raw = follower_pts + ratio_pts
    sub["community_influence"] = round(
        min(community_raw, 2.5) if _has_social_only_dormant_signal(m) else community_raw, 1
    )

    # 6. Activity Authenticity (17)
    contrib_pts = log_ratio(m["last_year_contributions"], 2000) * 8
    days = m["days_since_last_activity"]
    if days is None:
        recency_pts = 0.0
    elif days <= 90:
        recency_pts = 4.5
    elif days <= 365:
        recency_pts = 2.0
    else:
        recency_pts = 0.0
    diversity_pts = min(m["activity_type_count"], 4) * 1.125
    sub["activity_authenticity"] = round(contrib_pts + recency_pts + diversity_pts, 1)

    base = round(sum(sub.values()), 1)

    flags: List[Dict[str, Any]] = []

    def flag(name: str, penalty: float, detail: str) -> None:
        flags.append({"flag": name, "penalty": penalty, "detail": detail})

    fetched = max(m["fetched_repo_count"], 1)
    if m["account_age_years"] < 1 and m["public_repos"] > 30:
        flag("new_account_mass_repos", 10, f"Account <1yr old with {m['public_repos']} repos — possible mass creation.")
    if m["fork_repo_count"] / fetched > 0.7 and m["nonempty_original_repo_count"] <= 2:
        flag("mostly_forks", 10, f"{m['fork_repo_count']}/{fetched} repos are forks with little original work.")
    if m["nonempty_original_repo_count"] == 0:
        flag("no_original_work", 10, "No non-empty original repositories.")
    if m["empty_original_repo_count"] >= 5 and m["empty_original_repo_count"] / fetched > 0.5:
        flag("mostly_empty_repos", 5, f"{m['empty_original_repo_count']} empty original repos — likely placeholder/spam.")
    if m["following"] > 1000 and m["followers"] < m["following"] * 0.3:
        flag("follow_farming", 10, f"following {m['following']} >> followers {m['followers']} — follow-farming pattern.")
    if not m.get("bio") and m["followers"] < 3 and m["total_stars"] == 0 and m["merged_pr_count"] < 2:
        flag("ghost_profile", 8, "Empty profile with negligible footprint.")
    if (
        m["contribution_years_active"] <= 1
        and m["account_age_years"] > 2
        and _nz(m.get("days_since_last_activity"), 999) > 365
    ):
        flag("burst_then_dormant", 5, "Active in only one year then dormant — burst pattern.")
    if _has_social_only_dormant_signal(m):
        flag(
            "social_only_dormant_profile",
            5,
            f"{m['followers']} followers but 0 last-year contributions, 0 PRs, no external impact, "
            "and no strong original project signal — social/profile attention is disconnected from code work.",
        )
    if m["star_inflation_suspect"]:
        flag("possible_star_inflation", 5, "Top repo has many stars but near-zero forks/issues — possible bought stars.")
    sample = m["recent_merged_pr_sample"]
    external_trivial = _nz(m.get("external_trivial_pr_count"), 0)
    if sample >= 10 and external_trivial / sample > 0.5:
        flag(
            "trivial_pr_farming",
            8,
            f"{external_trivial}/{sample} recent merged PRs are ≤5-line changes into others' "
            "≥200★ repos — garbage PR farming into popular community projects.",
        )
    flood_penalty = templated_pr_flood_penalty(m)
    if flood_penalty is not None:
        flood_sample = _nz(m.get("recent_pr_sample"), 0)
        repo = _nz(m.get("top_repo_pr_target"), "one repo")
        share = _nz(m.get("top_repo_pr_share"), 0)
        templated = _nz(m.get("templated_pr_ratio"), 0)
        flag(
            "templated_pr_flooding",
            flood_penalty,
            f"近期 {_math_round(share * 100)}% 的 PR 集中刷向 {repo}，"
            f"{_math_round(templated * 100)}% 标题高度模板化（{flood_sample} 个样本）"
            " — 模式化批量贡献风险，需结合 diff 质量人工复核。",
        )
    rejected_prs = _nz(m.get("maintainer_closed_unmerged_pr_count"), _nz(m.get("closed_unmerged_pr_count"), 0))
    decided_prs = m["merged_pr_count"] + rejected_prs
    rejection = _nz(m.get("pr_rejection_rate"), 0)
    if decided_prs >= 10 and rejection > 0.5:
        flag(
            "high_pr_rejection",
            10 if rejection > 0.7 else 8,
            f"{rejected_prs}/{decided_prs} 个已决 PR 被维护者关闭未合并（被拒率 "
            f"{_math_round(rejection * 100)}%）— 低质 / 频繁被拒。",
        )

    penalty = min(sum(f["penalty"] for f in flags), 40)
    final = clamp_score(round(base - penalty, 2))
    t = tier_for(final)

    return {
        "sub_scores": sub,
        "base_score": base,
        "red_flags": flags,
        "total_penalty": penalty,
        "final_score": final,
        "tier": t["tier"],
        "tier_label": t["tier_label"],
    }

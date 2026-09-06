"""Public v10 risk layer shared by the Python SDK's local scorer.

This module deliberately does not know about the six positive dimensions. It
only turns bounded public evidence into auditable notes and high-confidence
active-manipulation penalties.
"""

from __future__ import annotations

import math
from typing import Any, Dict, List, Mapping, Optional, Tuple

RISK_VERSION = "v10"
TOTAL_CAP = 25.0
CONTRIBUTION_CAP = 16.0
SOCIAL_CAP = 9.0
FULL_SAMPLE = 40.0
MIN_CONTRIBUTION_SAMPLE = 20.0
MIN_REJECTION_DECISIONS = 20.0
MIN_FLOOD_SAMPLE = 20.0
TRIVIAL_RATE = 0.5
TRIVIAL_TRANSITION = 0.4
TEMPLATE_SHARE = 0.6
TEMPLATE_TITLE_RATIO = 0.6
FOLLOW_MINIMUM = 1500.0
FOLLOW_RATIO = 0.2
STAR_MINIMUM = 500.0
STAR_ENGAGEMENT_RATIO = 0.02
REJECTION_WILSON_LOWER = 0.4
WILSON_Z = 1.96
REVIEW_MINIMUM = 20.0
HIGH_MINIMUM = 60.0

WINDOW = "bounded public snapshot: up to 200 repositories, up to 50 merged PRs, up to 30 all-state PRs"


def _clamp01(value: float) -> float:
    if not math.isfinite(value):
        return 0.0
    return max(0.0, min(value, 1.0))


def _finite(value: Any, fallback: float = 0.0) -> float:
    return float(value) if isinstance(value, (int, float)) and math.isfinite(float(value)) else fallback


def _sample_factor(sample: float) -> float:
    return min(1.0, max(0.0, sample) / FULL_SAMPLE)


def smoothed_rate(events: float, sample: float) -> float:
    n = max(0.0, _finite(sample))
    x = max(0.0, min(n, _finite(events)))
    return (x + 1.0) / (n + 2.0)


def wilson_lower(rejected: float, decided: float, z: float = WILSON_Z) -> float:
    n = max(0.0, _finite(decided))
    if n <= 0:
        return 0.0
    x = max(0.0, min(n, _finite(rejected)))
    p = x / n
    z2 = z * z
    denominator = 1.0 + z2 / n
    numerator = p + z2 / (2.0 * n) - z * math.sqrt((p * (1.0 - p)) / n + z2 / (4.0 * n * n))
    return _clamp01(numerator / denominator)


def _coverage(m: Mapping[str, Any]) -> Dict[str, float]:
    fetched = max(0.0, _finite(m.get("fetched_repo_count")))
    public_repos = max(1.0, _finite(m.get("public_repos")))
    merged_sample = max(0.0, _finite(m.get("recent_merged_pr_sample")))
    merged_total = max(1.0, min(_finite(m.get("merged_pr_count")), 50.0))
    all_sample = max(0.0, _finite(m.get("recent_pr_sample")))
    all_total = max(1.0, min(_finite(m.get("total_pr_count")), 30.0))
    return {
        "repo": round(_clamp01(fetched / public_repos), 4),
        "merged_pr": round(_clamp01(merged_sample / merged_total), 4),
        "all_pr": round(_clamp01(all_sample / all_total), 4),
    }


def _confidence(coverage: Mapping[str, float]) -> float:
    return _clamp01(0.4 * coverage["repo"] + 0.4 * coverage["merged_pr"] + 0.2 * coverage["all_pr"])


def _evidence(m: Mapping[str, Any], observed: Dict[str, Any], sample: Optional[float] = None, threshold: Optional[Dict[str, float]] = None) -> Dict[str, Any]:
    result: Dict[str, Any] = {"observed": observed, "coverage": _coverage(m), "window": WINDOW}
    if sample is not None:
        result["sample_size"] = sample
    if threshold is not None:
        result["threshold"] = threshold
    return result


def _candidate(
    m: Mapping[str, Any],
    flag: str,
    family: str,
    raw: float,
    severity: float,
    confidence: float,
    detail: str,
    observed: Dict[str, Any],
    sample: Optional[float] = None,
    threshold: Optional[Dict[str, float]] = None,
) -> Dict[str, Any]:
    return {
        "raw": max(0.0, _finite(raw)),
        "signal": {
            "flag": flag,
            "family": family,
            "disposition": "note",
            "severity": round(_clamp01(severity), 4),
            "confidence": round(_clamp01(confidence), 4),
            "penalty": 0.0,
            "detail": detail,
            "evidence": _evidence(m, observed, sample, threshold),
        },
    }


def _add_footprint(m: Mapping[str, Any], candidates: List[Dict[str, Any]], flag: str, detail: str, observed: Dict[str, Any], severity: float) -> None:
    coverage = _coverage(m)
    sample = _finite(m.get("fetched_repo_count"))
    candidates.append(_candidate(m, flag, "footprint", 0.0, severity, _confidence(coverage), detail, observed, sample))


def _add_contribution(m: Mapping[str, Any], candidates: List[Dict[str, Any]], flag: str, raw: float, severity: float, detail: str, observed: Dict[str, Any], sample: float, threshold: Dict[str, float], confidence: float) -> None:
    candidates.append(_candidate(m, flag, "contribution", raw, severity, confidence * max(_sample_factor(sample), 0.25), detail, observed, sample, threshold))


def _apply_cap(candidates: List[Dict[str, Any]], family: str, cap: float) -> float:
    active = [item for item in candidates if item["signal"]["family"] == family and item["raw"] > 0]
    raw_total = sum(item["raw"] for item in active)
    if raw_total <= 0:
        return 0.0
    target = round(min(cap, raw_total), 2)
    factor = target / raw_total
    assigned = 0.0
    for index, item in enumerate(active):
        penalty = round(max(0.0, target - assigned), 2) if index == len(active) - 1 else round(item["raw"] * factor, 2)
        item["signal"]["penalty"] = penalty
        if penalty > 0:
            item["signal"]["disposition"] = "penalty"
        assigned = round(assigned + penalty, 2)
    return assigned


def _social_pair(follow_raw: float, star_raw: float, follow: Dict[str, Any], star: Dict[str, Any]) -> None:
    if follow_raw <= 0 or star_raw <= 0:
        return
    follow["raw"] = follow_raw + 0.5
    star["raw"] = star_raw + 0.5


def _social_only_dormant(m: Mapping[str, Any]) -> bool:
    return (
        _finite(m.get("followers")) >= 500
        and _finite(m.get("last_year_contributions")) == 0
        and _finite(m.get("merged_pr_count")) == 0
        and _finite(m.get("impact_pr_count")) == 0
        and _finite(m.get("max_impact_repo_stars")) == 0
        and _finite(m.get("total_stars")) <= 300
        and _finite(m.get("best_original_repo_quality_score")) < 0.85
    )


def assess_risk(m: Mapping[str, Any]) -> Tuple[Dict[str, Any], List[Dict[str, Any]], List[Dict[str, Any]], float]:
    candidates: List[Dict[str, Any]] = []
    coverage = _coverage(m)
    coverage_confidence = _confidence(coverage)
    fetched = max(1.0, _finite(m.get("fetched_repo_count")))

    if _finite(m.get("account_age_years")) < 1 and _finite(m.get("public_repos")) > 30:
        _add_footprint(m, candidates, "new_account_mass_repos", "新账号公开仓库较多，说明采集到的足迹可能来自批量建仓；这本身不等于作弊。", {"account_age_years": _finite(m.get("account_age_years")), "public_repos": _finite(m.get("public_repos"))}, 0.5)
    if _finite(m.get("fork_repo_count")) / fetched > 0.7 and _finite(m.get("nonempty_original_repo_count")) <= 2:
        _add_footprint(m, candidates, "mostly_forks", "公开仓库以 Fork 为主，原创足迹有限；这本身不等于作弊。", {"fork_repo_count": _finite(m.get("fork_repo_count")), "fetched_repo_count": fetched, "nonempty_original_repo_count": _finite(m.get("nonempty_original_repo_count"))}, 0.5)
    if _finite(m.get("nonempty_original_repo_count")) == 0:
        _add_footprint(m, candidates, "no_original_work", "当前公开采集范围内没有非空原创仓库；这只代表足迹有限，不代表作弊。", {"nonempty_original_repo_count": 0.0}, 0.7)
    if _finite(m.get("empty_original_repo_count")) >= 5 and _finite(m.get("empty_original_repo_count")) / fetched > 0.5:
        _add_footprint(m, candidates, "mostly_empty_repos", "公开原创仓库中空仓库占比较高；这只作为足迹提示，不扣分。", {"empty_original_repo_count": _finite(m.get("empty_original_repo_count")), "fetched_repo_count": fetched}, 0.5)
    if not m.get("bio") and _finite(m.get("followers")) < 3 and _finite(m.get("total_stars")) == 0 and _finite(m.get("merged_pr_count")) < 2:
        _add_footprint(m, candidates, "ghost_profile", "个人资料和公开项目足迹都很少，当前数据不足以判断行为真实性。", {"has_bio": False, "followers": _finite(m.get("followers")), "total_stars": _finite(m.get("total_stars")), "merged_pr_count": _finite(m.get("merged_pr_count"))}, 0.6)
    days = _finite(m.get("days_since_last_activity"), 999.0)
    if _finite(m.get("contribution_years_active")) <= 1 and _finite(m.get("account_age_years")) > 2 and days > 365:
        _add_footprint(m, candidates, "burst_then_dormant", "活动集中在较短时期且近期长期不活跃；这是时间覆盖提示，不扣分。", {"contribution_years_active": _finite(m.get("contribution_years_active")), "account_age_years": _finite(m.get("account_age_years")), "days_since_last_activity": days}, 0.5)
    if _social_only_dormant(m):
        _add_footprint(m, candidates, "social_only_dormant_profile", "社交关注度与当前公开代码足迹不匹配；这是待解释现象，不扣分。", {"followers": _finite(m.get("followers")), "last_year_contributions": _finite(m.get("last_year_contributions")), "merged_pr_count": _finite(m.get("merged_pr_count")), "total_stars": _finite(m.get("total_stars"))}, 0.5)

    merged_sample = max(0.0, _finite(m.get("recent_merged_pr_sample")))
    external_trivial = max(0.0, _finite(m.get("external_trivial_pr_count")))
    trivial_rate = smoothed_rate(external_trivial, merged_sample)
    trivial_severity = _clamp01((trivial_rate - TRIVIAL_RATE) / TRIVIAL_TRANSITION) * _sample_factor(merged_sample)
    trivial_raw = 8 * _clamp01((trivial_rate - TRIVIAL_RATE) / TRIVIAL_TRANSITION) * _sample_factor(merged_sample) if merged_sample >= MIN_CONTRIBUTION_SAMPLE and trivial_rate > TRIVIAL_RATE else 0.0
    if merged_sample > 0 and external_trivial > 0 and external_trivial / merged_sample > 0.3:
        detail = "外部热门仓库中的低实质 PR 比例偏高，但合并样本不足 20 个，仅作风险提示。" if merged_sample < MIN_CONTRIBUTION_SAMPLE else "外部热门仓库中的低实质 PR 比例达到量化阈值；仅统计他人仓库，不惩罚正常自提 PR。"
        _add_contribution(m, candidates, "trivial_pr_farming", trivial_raw, trivial_severity, detail, {"external_trivial_pr_count": external_trivial, "merged_pr_sample": merged_sample, "smoothed_rate": round(trivial_rate, 4)}, merged_sample, {"minimum_sample": MIN_CONTRIBUTION_SAMPLE, "smoothed_rate": TRIVIAL_RATE}, coverage_confidence)

    rejection_measured = m.get("maintainer_closed_unmerged_pr_count") is not None
    rejected = max(0.0, _finite(m.get("maintainer_closed_unmerged_pr_count"))) if rejection_measured else 0.0
    decided = max(0.0, _finite(m.get("merged_pr_count"))) + rejected
    rejection_lower = wilson_lower(rejected, decided) if rejection_measured else 0.0
    rejection_severity = _clamp01((rejection_lower - REJECTION_WILSON_LOWER) / REJECTION_WILSON_LOWER) * _sample_factor(decided)
    rejection_raw = 4 * _clamp01((rejection_lower - REJECTION_WILSON_LOWER) / REJECTION_WILSON_LOWER) if rejection_measured and decided >= MIN_REJECTION_DECISIONS and rejection_lower >= REJECTION_WILSON_LOWER else 0.0
    if rejection_measured and decided > 0 and rejected > 0:
        detail = "维护者关闭未合并的 PR 比例偏高，但样本量或 Wilson 95% 下界未达到扣分门槛，仅作风险提示。" if decided < MIN_REJECTION_DECISIONS or rejection_lower < REJECTION_WILSON_LOWER else "维护者关闭未合并的 PR 的 Wilson 95% 下界达到量化阈值。"
        _add_contribution(m, candidates, "high_pr_rejection", rejection_raw, rejection_severity, detail, {"maintainer_closed_unmerged_pr_count": rejected, "merged_pr_count": _finite(m.get("merged_pr_count")), "decided_pr_count": decided, "wilson_lower": round(rejection_lower, 4)}, decided, {"minimum_decisions": MIN_REJECTION_DECISIONS, "wilson_lower": REJECTION_WILSON_LOWER}, coverage_confidence)

    flood_sample = max(0.0, _finite(m.get("recent_pr_sample")))
    share = _clamp01(_finite(m.get("top_repo_pr_share")))
    templated_ratio = _clamp01(_finite(m.get("templated_pr_ratio")))
    # The collector sets this only after verifying that the dominant target is
    # external. A similar pattern in the user's own repository is normal work.
    flood_observed = bool(m.get("pr_flood_suspect"))
    pattern_pass = flood_sample >= MIN_FLOOD_SAMPLE and share >= TEMPLATE_SHARE and templated_ratio >= TEMPLATE_TITLE_RATIO
    pattern_severity = _clamp01(((share - TEMPLATE_SHARE) / (1 - TEMPLATE_SHARE) + (templated_ratio - TEMPLATE_TITLE_RATIO) / (1 - TEMPLATE_TITLE_RATIO)) / 2)
    corroborating_severity = max(trivial_severity, rejection_severity)
    template_raw = 8 * pattern_severity * corroborating_severity if pattern_pass and corroborating_severity > 0 else 0.0
    if flood_observed:
        corroborating = corroborating_severity > 0
        detail = "PR 目标集中且标题模板化，并有外部低实质贡献或维护者拒绝率作为第二项证据；已按贡献风险族封顶。" if pattern_pass and corroborating else "PR 目标集中或标题模板化，但缺少第二项独立质量证据；仅作风险提示，不单独扣分。"
        _add_contribution(m, candidates, "templated_pr_flooding", template_raw, pattern_severity, detail, {"recent_pr_sample": flood_sample, "top_repo_pr_share": share, "templated_pr_ratio": templated_ratio, "corroborating_evidence": corroborating}, flood_sample, {"minimum_sample": MIN_FLOOD_SAMPLE, "target_share": TEMPLATE_SHARE, "title_ratio": TEMPLATE_TITLE_RATIO}, coverage_confidence)

    following = max(0.0, _finite(m.get("following")))
    followers = max(0.0, _finite(m.get("followers")))
    follower_ratio = followers / max(following, 1.0)
    follow_observed = following > 0 and follower_ratio < FOLLOW_RATIO
    follow_raw = 4 * _clamp01((FOLLOW_RATIO - follower_ratio) / FOLLOW_RATIO) * _clamp01((following - FOLLOW_MINIMUM) / 3000) if following >= FOLLOW_MINIMUM and follower_ratio < FOLLOW_RATIO else 0.0
    follow: Optional[Dict[str, Any]] = None
    if follow_observed:
        follow = _candidate(m, "follow_farming", "social", 0.0, _clamp01((FOLLOW_RATIO - follower_ratio) / FOLLOW_RATIO), coverage_confidence, "关注数量与粉丝数量明显失衡；当前只有单次快照，没有关注增长时间序列，不能单独判定刷粉。", {"following": following, "followers": followers, "follower_ratio": round(follower_ratio, 4)}, threshold={"minimum_following": FOLLOW_MINIMUM, "follower_ratio": FOLLOW_RATIO})
        candidates.append(follow)

    engagement = m.get("top_repo_engagement_ratio")
    star_observed = bool(m.get("star_inflation_suspect"))
    star_raw = 4 * _clamp01((STAR_ENGAGEMENT_RATIO - _finite(engagement)) / STAR_ENGAGEMENT_RATIO) if star_observed and _finite(m.get("max_stars")) >= STAR_MINIMUM and engagement is not None else 0.0
    star: Optional[Dict[str, Any]] = None
    if star_observed:
        severity = _clamp01(star_raw / 4) if star_raw > 0 else 0.5
        detail = "高星标仓库的可测 engagement ratio 很低，且存在星标膨胀形态；只有与关注失衡同时出现才扣分。" if star_raw > 0 else "存在星标/互动失衡迹象，但缺少足够星标或可公平测量的 engagement ratio，仅作风险提示。"
        star = _candidate(m, "possible_star_inflation", "social", 0.0, severity, coverage_confidence, detail, {"max_stars": _finite(m.get("max_stars")), "star_inflation_suspect": star_observed, "engagement_ratio": _finite(engagement) if engagement is not None else None}, threshold={"minimum_stars": STAR_MINIMUM, "engagement_ratio": STAR_ENGAGEMENT_RATIO})
        candidates.append(star)

    if follow is not None and star is not None:
        _social_pair(follow_raw, star_raw, follow, star)
        if follow_raw <= 0 or star_raw <= 0:
            follow["raw"], star["raw"] = 0.0, 0.0
            follow["signal"]["detail"] = "关注失衡是单一社交异常；没有第二项独立星标证据，不扣分。"
            star["signal"]["detail"] = "星标/互动异常是单一热度异常；没有第二项独立关注证据，不扣分。"

    contribution_penalty = _apply_cap(candidates, "contribution", CONTRIBUTION_CAP)
    social_penalty = _apply_cap(candidates, "social", SOCIAL_CAP)
    total_penalty = round(min(TOTAL_CAP, contribution_penalty + social_penalty), 2)
    signals = [item["signal"] for item in candidates]
    notes = []
    red_flags = []
    for signal in signals:
        if signal["penalty"] > 0:
            red_flags.append({"flag": signal["flag"], "penalty": signal["penalty"], "detail": signal["detail"]})
        else:
            note = dict(signal)
            note["penalty"] = 0.0
            note["disposition"] = "note"
            notes.append(note)
    risk_score = round(total_penalty / TOTAL_CAP * 100, 2)
    level = "high" if risk_score >= HIGH_MINIMUM else "review" if risk_score >= REVIEW_MINIMUM else "none"
    assessment = {
        "version": RISK_VERSION,
        "risk_score": risk_score,
        "level": level,
        "confidence": round(_confidence(coverage) * 100, 2),
        "applied_penalty": total_penalty,
        "signals": signals,
        "coverage": coverage,
    }
    return assessment, notes, red_flags, total_penalty

"""Pin the CLI rating ladder to the canonical rule in scoring/src/rating.ts."""

import json
import math
from pathlib import Path

from ghfind import _cli

FIXTURE = json.loads(
    (Path(__file__).resolve().parents[3] / "scoring" / "fixtures" / "rating-ladder.json").read_text()
)


def test_thresholds_match_canonical_ladder():
    assert [row[0] for row in _cli._REALM_DEFS] == [step["minScore"] for step in FIXTURE["ladder"]]


def test_levels_and_ratings_match_fixture():
    rank_by_id = {step["id"]: step["rank"] for step in FIXTURE["ladder"]}
    zh_by_rank = {i + 1: row[1] for i, row in enumerate(_cli._REALM_DEFS)}
    for case in FIXTURE["cases"]:
        assert _cli._adventurer_level(case["score"]) == case["level"], case
        assert _cli._realm_name(case["score"], "zh") == zh_by_rank[rank_by_id[case["rating"]]], case


def test_non_finite_scores_are_entry_rating_at_level_one():
    for s in (math.nan, math.inf, -math.inf, "inf", None, "x"):
        assert _cli._adventurer_level(s) == 1
        assert _cli._realm_name(s, "zh") == _cli._REALM_DEFS[0][1]

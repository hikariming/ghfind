"""Bit-exact parity: feeding the golden `metrics` (captured from the TS/website
engine) into the Python `score()` must reproduce the golden `scoring` exactly.

Fixtures live in tests/fixtures/golden_scores.json and are generated from the
already-verified TypeScript `@ghfind/scoring` output — see the repo's fixture dumper.
"""

import json
import os

import pytest

from ghfind._score import score

FIXTURES = os.path.join(os.path.dirname(__file__), "fixtures", "golden_scores.json")

with open(FIXTURES, encoding="utf-8") as f:
    GOLDEN = json.load(f)


@pytest.mark.parametrize("case", GOLDEN, ids=[c["username"] for c in GOLDEN])
def test_score_matches_golden(case):
    got = score(case["metrics"])
    want = case["scoring"]

    assert got["final_score"] == want["final_score"], (
        f"{case['username']}: final {got['final_score']} != {want['final_score']}"
    )
    assert got["base_score"] == want["base_score"]
    assert got["total_penalty"] == want["total_penalty"]
    assert got["tier"] == want["tier"]
    assert got["tier_label"] == want["tier_label"]
    assert got["sub_scores"] == want["sub_scores"], (
        f"{case['username']}: sub_scores {got['sub_scores']} != {want['sub_scores']}"
    )
    # Red flags: same set of (flag, penalty) in the same order.
    assert [(f["flag"], f["penalty"]) for f in got["red_flags"]] == [
        (f["flag"], f["penalty"]) for f in want["red_flags"]
    ]


def test_fixtures_present():
    assert len(GOLDEN) >= 3

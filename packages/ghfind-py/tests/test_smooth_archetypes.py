"""Shared fictitious v19 archetype scores. No production identities."""
import json
from pathlib import Path

import pytest

from ghfind._score import score

CASES = json.loads((Path(__file__).resolve().parents[3] / "src/lib/__tests__/smooth-impact-archetypes.json").read_text())


@pytest.mark.parametrize("case", CASES, ids=[c["name"] for c in CASES])
def test_shared_archetype(case):
    got = score(case["metrics"])
    assert got["sub_scores"]["ecosystem_impact"] == case["ecosystem_impact"]
    assert got["sub_scores"]["contribution_quality"] == case["contribution_quality"]
    assert got["final_score"] == case["final_score"]


def test_concentration_does_not_fill_impact():
    by_name = {case["name"]: case for case in CASES}
    assert by_name["few-tiny-prs-mega-repo"]["ecosystem_impact"] < 6
    assert by_name["one-repo-sustained"]["ecosystem_impact"] < by_name["four-repo-spread"]["ecosystem_impact"]
    assert by_name["five-repo-core"]["ecosystem_impact"] > 15

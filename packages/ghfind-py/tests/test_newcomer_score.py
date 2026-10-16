"""v10 scoring has no newcomer maturity bonus (stdlib runner)."""
import json
import unittest
from pathlib import Path

from ghfind._score import score

FIXTURE = Path(__file__).resolve().parents[3] / "src/lib/__tests__/newcomer-score-fixtures.json"
with FIXTURE.open(encoding="utf-8") as f:
    DATA = json.load(f)


class V10ScoreHasNoNewcomerBonusTests(unittest.TestCase):
    def test_maturity_is_age_and_span_only(self):
        m = DATA["metrics"]
        age_pts = min(m["account_age_years"] / 6, 1) * 7
        years = m["contribution_years_active"]
        span_pts = 0 if years == 0 else 1 if years == 1 else 2 if years == 2 else 3
        self.assertEqual(score(m)["sub_scores"]["account_maturity"], round(age_pts + span_pts, 1))

    def test_created_at_does_not_change_score(self):
        m = DATA["metrics"]
        self.assertEqual(score(m)["sub_scores"], score({**m, "created_at": None})["sub_scores"])
        self.assertEqual(score(m)["final_score"], score({**m, "created_at": None})["final_score"])


if __name__ == "__main__":
    unittest.main()

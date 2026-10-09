"""Shared TS/Go/Python regression and newcomer bonus invariants (stdlib runner)."""
import json
import math
import unittest
from pathlib import Path

from ghfind._risk import assess_risk
from ghfind._score import _super_newcomer_bonus, score

FIXTURE = Path(__file__).resolve().parents[3] / "src/lib/__tests__/newcomer-score-fixtures.json"
with FIXTURE.open(encoding="utf-8") as f:
    DATA = json.load(f)


def bonus_for(m):
    risk, _, _, penalty = assess_risk(m)
    return _super_newcomer_bonus(m, score(m)["sub_scores"], risk, penalty)


class SuperNewcomerScoreTests(unittest.TestCase):
    def test_shared_fixtures_and_isolation(self):
        for row in DATA["cases"]:
            with self.subTest(row["name"]):
                m = {**DATA["metrics"], **row.get("overrides", {})}
                for key in row.get("omit", []):
                    m.pop(key, None)
                got = score(m)
                for key in ("sub_scores", "base_score", "final_score", "total_penalty"):
                    self.assertEqual(got[key], row["expected"][key])
                self.assertAlmostEqual(bonus_for(m), row["expected"]["bonus"], places=10)
                old = score({**m, "created_at": None})
                delta = got["sub_scores"]["account_maturity"] - old["sub_scores"]["account_maturity"]
                self.assertGreaterEqual(delta, 0)
                self.assertLessEqual(delta, 4.00000001)
                self.assertLessEqual(got["sub_scores"]["account_maturity"], 10)
                for key, value in got["sub_scores"].items():
                    if key != "account_maturity":
                        self.assertEqual(value, old["sub_scores"][key])
                self.assertEqual(got["risk_assessment"], old["risk_assessment"])

    def test_decay_and_overlap(self):
        last = 4.0
        for month in range(49):
            m = {**DATA["metrics"], "account_age_years": month / 12}
            bonus = bonus_for(m)
            self.assertGreaterEqual(bonus, 0)
            self.assertLessEqual(bonus, last + 1e-12)
            if month >= 36:
                self.assertEqual(score(m), score({**m, "created_at": None}))
            last = bonus

    def test_invalid_age_and_optional_evidence(self):
        m = DATA["metrics"]
        sub = score(m)["sub_scores"]
        risk, _, _, penalty = assess_risk(m)
        for age in (-1, math.nan, math.inf):
            self.assertEqual(_super_newcomer_bonus({**m, "account_age_years": age}, sub, risk, penalty), 0)
        for key in ("best_original_repo_quality_score", "verified_impact_pr_count", "core_impact_pr_count", "impact_depth_raw", "recent_merged_pr_sample", "days_since_last_activity"):
            self.assertEqual(_super_newcomer_bonus({**m, key: math.nan}, sub, risk, penalty), 0)

    def test_smooth_eligibility_and_growth(self):
        m = DATA["metrics"]
        self.assertEqual(bonus_for({**m, "best_original_repo_quality_score": .55}), 0)
        self.assertLess(bonus_for({**m, "best_original_repo_quality_score": .550001}), 1e-8)
        partial = bonus_for({**m, "best_original_repo_quality_score": .7})
        self.assertAlmostEqual(partial, bonus_for(m) / 2, places=10)
        self.assertGreater(bonus_for({**m, "account_age_years": 1}), partial)


if __name__ == "__main__":
    unittest.main()

"""Structured representation of restored pre-v10 flat deductions."""


def legacy_risk_details(flags, penalty, eligibility):
    names = {flag["flag"] for flag in flags}
    notes = [dict(signal) for signal in eligibility["signals"]
             if signal["penalty"] <= 0.005 and signal["flag"] not in names]
    measured = {signal["flag"]: signal for signal in eligibility["signals"]}
    signals = []
    for flag in flags:
        name = flag["flag"]
        family = ("social" if name in ("follow_farming", "possible_star_inflation") else
                  "contribution" if name in ("trivial_pr_farming", "templated_pr_flooding", "high_pr_rejection") else "footprint")
        signal = dict(measured.get(name, {
            "severity": 0, "confidence": 0,
            "evidence": {"observed": {}, "coverage": eligibility["coverage"], "window": "bounded public snapshot"},
        }))
        signal["evidence"] = dict(signal["evidence"], threshold={"total_penalty_cap": 40})
        signal.update(flag, family=family, disposition="penalty")
        signals.append(signal)
    risk_score = penalty / 40 * 100
    return dict(eligibility, version="v9", applied_penalty=penalty, risk_score=risk_score,
                level="high" if risk_score >= 60 else "review" if risk_score >= 20 else "none",
                signals=signals + notes), notes

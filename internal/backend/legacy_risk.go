package backend

// legacyRiskDetails keeps structured API/storage compatibility without labeling
// restored flat deductions as the v10 policy. Individual flags retain raw points;
// AppliedPenalty is capped at 40, just as in the pre-v10 scorer.
func legacyRiskDetails(flags []RedFlag, penalty float64, eligibility RiskAssessment) (RiskAssessment, []RiskSignal) {
	names := map[string]bool{}
	signals := make([]RiskSignal, 0)
	for _, flag := range flags {
		names[flag.Flag] = true
		family := "footprint"
		switch flag.Flag {
		case "follow_farming", "possible_star_inflation":
			family = "social"
		case "trivial_pr_farming", "templated_pr_flooding", "high_pr_rejection":
			family = "contribution"
		}
		signal := RiskSignal{Evidence: RiskEvidence{Observed: map[string]any{}, Coverage: map[string]float64{"repo": eligibility.Coverage.Repo, "merged_pr": eligibility.Coverage.MergedPR, "all_pr": eligibility.Coverage.AllPR}, Window: "bounded public snapshot"}}
		for _, measured := range eligibility.Signals {
			if measured.Flag == flag.Flag {
				signal = measured
				break
			}
		}
		signal.Evidence.Threshold = map[string]float64{"total_penalty_cap": 40}
		signal.Flag, signal.Family, signal.Disposition = flag.Flag, family, "penalty"
		signal.Penalty, signal.Detail = flag.Penalty, flag.Detail
		signals = append(signals, signal)
	}
	notes := make([]RiskSignal, 0)
	for _, signal := range eligibility.Signals {
		if signal.Penalty <= 0.005 && !names[signal.Flag] {
			signal.Penalty, signal.Disposition = 0, "note"
			notes = append(notes, signal)
		}
	}
	eligibility.Version, eligibility.AppliedPenalty = "v9", penalty
	eligibility.RiskScore, eligibility.Level = penalty/40*100, "none"
	if eligibility.RiskScore >= 60 {
		eligibility.Level = "high"
	} else if eligibility.RiskScore >= 20 {
		eligibility.Level = "review"
	}
	eligibility.Signals = append(signals, notes...)
	return eligibility, notes
}

package backend

import "testing"

func riskTestFloat(value float64) *float64 { return &value }

func neutralRiskMetrics() RawMetrics {
	return RawMetrics{
		Username: "risk-test", AccountAgeYears: 5, Followers: 50, Following: 30,
		PublicRepos: 20, FetchedRepoCount: 20, OriginalRepoCount: 10,
		NonemptyOriginalRepoCount: 5, ForkRepoCount: 2, TotalStars: 100, MaxStars: 50,
		MergedPRCount: 30, TotalPRCount: 35, IssuesCreated: 10,
		LastYearContributions: 500, ActivityTypeCount: 3, ContributionYearsActive: 3,
		RecentMergedPRSample: 20, RecentTrivialPRCount: 2, ExternalTrivialPRCount: 0,
		MaxImpactRepoStars: 0, ImpactPRCount: 0, ImpactDepthRaw: 0,
		StarInflationSuspect: false, ClosedUnmergedPRCount: 2, PRRejectionRate: 0.06,
		RecentPRSample: 20, TopRepoPRTarget: riskTestString("someone/project"),
		TopRepoPRShare: 0.3, TemplatedPRRatio: 0.2, PRFloodSuspect: false,
	}
}

func riskTestString(value string) *string { return &value }

func riskFlags(output Scoring) map[string]RiskSignal {
	flags := make(map[string]RiskSignal)
	for _, signal := range output.RiskAssessment.Signals {
		flags[signal.Flag] = signal
	}
	return flags
}

func TestV10RiskRules(t *testing.T) {
	t.Run("footprint is note only", func(t *testing.T) {
		m := neutralRiskMetrics()
		m.AccountAgeYears, m.PublicRepos, m.FetchedRepoCount = 0.5, 40, 40
		m.OriginalRepoCount, m.NonemptyOriginalRepoCount, m.ForkRepoCount, m.EmptyOriginalRepoCount = 5, 0, 5, 5
		m.Bio, m.Followers, m.Following, m.TotalStars, m.MaxStars = nil, 0, 0, 0, 0
		m.MergedPRCount, m.TotalPRCount, m.LastYearContributions, m.ActivityTypeCount = 0, 0, 0, 0
		m.RecentMergedPRSample, m.RecentPRSample = 0, 0
		output := Score(m)
		if output.TotalPenalty != 0 || len(output.RedFlags) != 0 {
			t.Fatalf("footprint penalty=%v flags=%#v", output.TotalPenalty, output.RedFlags)
		}
		if signal := riskFlags(output)["no_original_work"]; signal.Disposition != "note" || signal.Penalty != 0 {
			t.Fatalf("no_original_work=%#v", signal)
		}
	})

	t.Run("self repository flooding is ignored", func(t *testing.T) {
		m := neutralRiskMetrics()
		m.RecentMergedPRSample, m.RecentPRSample = 30, 30
		m.TopRepoPRShare, m.TemplatedPRRatio, m.PRFloodSuspect = 1, 1, false
		output := Score(m)
		if output.TotalPenalty != 0 || len(output.RedFlags) != 0 {
			t.Fatalf("self repository penalty=%v flags=%#v", output.TotalPenalty, output.RedFlags)
		}
	})

	t.Run("small trivial sample is note only", func(t *testing.T) {
		m := neutralRiskMetrics()
		m.RecentMergedPRSample, m.ExternalTrivialPRCount = 19, 15
		output := Score(m)
		if output.TotalPenalty != 0 || riskFlags(output)["trivial_pr_farming"].Disposition != "note" {
			t.Fatalf("trivial risk=%#v", output)
		}
	})

	t.Run("template requires corroboration", func(t *testing.T) {
		m := neutralRiskMetrics()
		m.RecentPRSample, m.TopRepoPRShare, m.TemplatedPRRatio, m.PRFloodSuspect = 30, 1, 1, true
		onlyTemplate := Score(m)
		if onlyTemplate.TotalPenalty != 0 || riskFlags(onlyTemplate)["templated_pr_flooding"].Disposition != "note" {
			t.Fatalf("template-only risk=%#v", onlyTemplate)
		}

		m.RecentMergedPRSample, m.ExternalTrivialPRCount = 30, 30
		corroborated := Score(m)
		if corroborated.TotalPenalty <= 0 || len(corroborated.RedFlags) != 2 {
			t.Fatalf("corroborated risk=%#v", corroborated)
		}
	})

	t.Run("social evidence is conjunctive", func(t *testing.T) {
		m := neutralRiskMetrics()
		m.Following, m.Followers = 2000, 100
		single := Score(m)
		if single.TotalPenalty != 0 || riskFlags(single)["follow_farming"].Disposition != "note" {
			t.Fatalf("single social signal=%#v", single)
		}

		m.Following, m.Followers = 10_000, 0
		m.StarInflationSuspect, m.MaxStars, m.TopRepoEngagementRatio = true, 10_000, riskTestFloat(0)
		paired := Score(m)
		if paired.TotalPenalty <= 0 || paired.TotalPenalty > riskSocialCap {
			t.Fatalf("paired social penalty=%v", paired.TotalPenalty)
		}
	})

	t.Run("missing optional metrics never penalize", func(t *testing.T) {
		m := neutralRiskMetrics()
		m.StarInflationSuspect, m.MaxStars = true, 2000
		output := Score(m)
		if output.TotalPenalty != 0 || riskFlags(output)["possible_star_inflation"].Disposition != "note" {
			t.Fatalf("missing engagement risk=%#v", output)
		}
	})

	t.Run("all families remain capped", func(t *testing.T) {
		m := neutralRiskMetrics()
		m.MergedPRCount, m.MaintainerClosedUnmergedPRCount = 40, riskTestFloat(40)
		m.RecentMergedPRSample, m.ExternalTrivialPRCount = 40, 40
		m.RecentPRSample, m.TopRepoPRShare, m.TemplatedPRRatio, m.PRFloodSuspect = 40, 1, 1, true
		m.Following, m.Followers = 10_000, 0
		m.StarInflationSuspect, m.MaxStars, m.TopRepoEngagementRatio = true, 10_000, riskTestFloat(0)
		output := Score(m)
		if output.TotalPenalty != riskTotalCap || output.RiskAssessment.RiskScore != 100 || output.RiskAssessment.Level != "high" {
			t.Fatalf("capped risk=%#v", output)
		}
	})
}

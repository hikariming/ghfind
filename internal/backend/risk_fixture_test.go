package backend

// Copy of scoring.neutralRiskMetrics for backend tests that combine the
// public formula with private profile/score API validation.
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
		RecentPRSample: 20, TopRepoPRTarget: riskFixtureString("someone/project"),
		TopRepoPRShare: 0.3, TemplatedPRRatio: 0.2, PRFloodSuspect: false,
	}
}

func riskFixtureString(value string) *string { return &value }

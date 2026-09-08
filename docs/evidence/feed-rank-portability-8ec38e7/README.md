# Ranking fixture portability diagnosis

The `8ec38e7` ranker and capacity-a fixture were run under host Go 1.26.1
macOS/arm64 and the pinned Go 1.23 Linux/amd64 Docker image. The Linux/amd64
hashes reproduced the CI failure exactly. Linux/arm64 Go 1.23 had already
matched the original hashes, establishing an architecture-dependent difference.

For capacity-a, all225 project identities, order, branch flags, source/reason
strings and integer fields matched. There were103 floating-point differences:
37 freshness values,33 scores,29 MMR scores and4 propensities. The largest absolute
difference was 3.3306690738754696e-16. Numeric differences are retained separately.
This is floating-point evaluation/rounding sensitivity, not a changed sampling
branch or candidate policy. The evidence does not attribute every difference
solely to math.Exp rather than other floating-point operations.

The test now runs the frozen 5a3333d cubic reference algorithm and the optimized
algorithm on each platform, and requires exact equality of their complete
private ranked results. The independent fixed digest then normalizes only
numeric JSON leaves to 12 decimal places; other data remains exact. This permits
very small representation differences across platforms without weakening the
within-platform full-output comparison or the existing analytical propensity
and rolling quota tests. No production ranking implementation changed.

Pinned Docker image:
`golang:1.23-alpine@sha256:383395b794dffa5b53012a212365d40c8e37109a626ca30d6151c8348d380b5f`.
The diagnosis was run with `docker run --platform linux/amd64 ... go test
./internal/backend -run '^TestFeedRankIncrementalMMRGolden$' -count=1`.

# @ghfind/scoring

The public, deterministic half of ghfind: how public GitHub evidence becomes a
0–100 score and a rating. It has no network, token, environment, storage or
clock access (`now` is always a parameter). See
[`docs/architecture/open-core-split.md`](../docs/architecture/open-core-split.md).

| Module | What it does |
| --- | --- |
| `types` | Evidence shapes (`TopRepo`, `RecentPr`, `ImpactRepo`, …), the `RawMetrics` contract and `Scoring`. |
| `extract` | Pure evidence → RawMetrics derivation: impact, community, star weighting, content-skill and quality signals. |
| `score` | Six dimensions and risk → `Scoring` (`score(metrics)`). |
| `risk`, `legacy-risk`, `rules/` | Risk rules and their parameters. |
| `rating` | The rating ladder: 30–100, one rating every 10 points, `Lv = floor(score)`. |
| `score-presentation` | Sub-score caps, plus the **legacy** five-tier `tierFor` still stored in `Scoring.tier`. |
| `fixtures/` | Cross-runtime parity cases shared by TypeScript, Go and Python. |

```ts
import { score, ratingForScore, ratingLevel } from "@ghfind/scoring";

const scoring = score(rawMetrics);              // same RawMetrics the API returns
const rating = ratingForScore(scoring.final_score); // { id: "deity", minScore: 60, rank: 5 }
console.log(`Lv.${ratingLevel(scoring.final_score)} ${rating.id}`);
```

```go
import "github.com/hikariming/ghfind/scoring"

result := scoring.Score(metrics)
step := scoring.RatingForScore(result.FinalScore)
```

## Develop

```sh
pnpm --filter @ghfind/scoring typecheck && pnpm --filter @ghfind/scoring test
(cd scoring && go test ./...)
(cd packages/ghfind-py && python3 -m pytest -q)
pnpm scoring:boundary          # purity / credential / import gate
pnpm --filter @ghfind/scoring fixtures:rating   # regenerate fixtures/rating-ladder.json
```

Any formula change has to update all three ports and their fixtures in the
same review. If outputs change, the score version in the backend must be bumped
as well.

## Release

Push a `scoring/vX.Y.Z` tag that matches `package.json`'s version.
`.github/workflows/scoring-release.yml` re-runs CI, publishes the npm package
and GitHub release, and notifies the private backend, which opens an upgrade PR.

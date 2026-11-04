# discover-score-v1 (Phase B, inert)

Status: merged code is **off by default**. Production cards, Feed ranking and
boards still read `product_score` (rubric `project-value-v1`). No assessment
was rewritten; the sample rescore ran offline against read-only public
assessment views.

## Why a second number

`product_score` answers "is this product worth using?" and stays the board
number. On Discover the bare number reads badly:

- **Compressed middle.** On the 2026-10-23 public corpus (283 assessments),
  P25–P75 is 60–72; 69% of projects sit in 60–79. A reader cannot tell a 66
  from a 71, yet that gap spans most of the catalogue.
- **Halo across dimensions.** pain vs effectiveness correlate at 0.77, so the
  four dimensions mostly restate one impression.
- **Junk on the shelf.** Empty repos, demo fixtures and abandoned code are on
  the public board with 0–18 and still get a card.
- **Thin evidence looks like a verdict.** 99% are `source_inspected`, median
  confidence 62, but nothing on the card changes with confidence.

## Semantics

`discover_score` (0–100) = "how worth a click is this for a stranger browsing
Discover". Bands (labels are the zh UI copy):

| score | band | reader should feel |
| --- | --- | --- |
| 85–100 | must_try / 强推 | install it now |
| 70–84 | worth_a_look / 值得看 | open the card |
| 55–69 | situational / 看场景 | depends on your use case |
| 40–54 | weak / 谨慎 | half-done or narrow |
| 0–39 | skip / 不推荐 | not worth your time |

Components (each 0–1, derived from the existing artifact; the evaluator never
writes this score):

| component | from | Discover meaning |
| --- | --- | --- |
| usefulness | 0.45·pain + 0.55·effectiveness | real pain, actually removed |
| tryability | experience | short path to first success |
| focus | value_density | benefit per unit of burden |
| maturity | lifecycle | still works next month |
| adoption | community_strength + exposure, saturating at `established` | someone else relies on it |

Partition fit = per-partition weights (`agent`, `skill`, `microservice`,
`sandbox`, `none`). Partition comes **only** from canonical tags
(`use_case:ai-agent`, `use_case:agent-skill`, `artifact:microservice`,
`artifact:sandbox`); #525 keyword cues remain a chip-filter fallback and never
change a score (they were right on 7 of 26 sampled matches).

Then: confidence shrink (downward only, toward 50), a frozen calibration curve
(versioned knots), and caps: abandoned ≤39, experimental ≤69, metadata_only
≤54, critical risk ≤54, sandbox + high security risk ≤54, and
`eligible=false` (≤24, hidden) when effectiveness <8, pain <7 or
product_score <25.

The result also carries up to two `reasons` and two `limits` as machine codes
for UI chips (no generated prose).

## Copy contract v6 (draft)

`lintDiscoverHookV6`: ≤64 CJK / ≤120 Latin chars; no template lead
("X 是一个…", "一个…的工具", "X is a …"), no repo-name lead, no report voice
("目标用户…", "没有本项目时…", "试图…"), no marketing filler, no truncation
ellipsis. 277/283 live hooks fail it today, mostly on length.

## Rollout (needs owner sign-off for each step past 1)

1. (this PR) scorer + tests + offline shadow script; flag `GHFIND_DISCOVER_SCORE_V1` unused in prod.
2. Feed projection columns `discover_score`, `discover_score_version` computed by this same module at projection time (dual-write, readers ignore).
3. Skill v6 (copy contract + mandatory canonical partition tags) on a control set of 50–200 repos via ops-private list; blind review.
4. Flag on for internal accounts; then a small traffic slice showing band labels.
5. Only then a paced, checkpointed rescore; never delete prior artifacts.

## v1.1: try gate for the top band (owner decision 2026-10-23)

Problem: on the public corpus, 14 of 25 `must_try` projects were mainstream or
had community_strength ≥ 80, including an OS kernel tree, a BSD source tree, a
distributed log broker and a game-server proxy. They are excellent for their
own experts (the `experience` dimension scores the target users), but a
stranger on Discover cannot "install it now".

Rule (`discover-score-v1.1`, still opt-in):

1. **Stranger tryability** (0..1). From skill v6 `project.time_to_first_value`
   when present: minutes 1, hour 0.75, day 0.4, weeks 0.1. Otherwise a proxy:
   `experience/30 × type reach` (framework_platform 0.8, database_infra and
   enterprise_system 0.7, other types 1).
2. **Top band needs tryability.** `must_try` (≥85) requires stranger
   tryability ≥ 0.7; otherwise the score is capped at 84 (`hard_to_try`).
3. **Mega projects need a higher bar, not a star cap.** When exposure is
   `mainstream` or community_strength ≥ 80 the bar is 0.8. Popularity alone
   never lowers a score; an easy-to-try famous library still reaches the top.
4. **Weeks to value** (v6 field) caps at 69 (`weeks_to_value`).
5. With TTFV, tryability = 0.5·experience + 0.5·TTFV, so time-to-first-value
   is weighted into every score, not only the top band.

Effect with the proxy only (no v6 fields yet):

| set | v1 bands (强推/值得看/看场景/谨慎/不推荐) | v1.1 bands | mega in 强推 |
| --- | --- | --- | --- |
| 283 public | 25/77/110/46/25 | 16/86/110/46/25 | 14 → 6 |
| 38 sample | 9/10/7/6/6 | 5/14/7/6/6 | 6 → 2 |

Remaining mega `must_try` items are all minutes-to-value (a CI checkout step,
an editor, small libraries).

## Skill v6 candidate (control run only)

Not wired to production. Differences from v5:

- `project.discover_hook`: ≤64 CJK / ≤120 Latin; friction → concrete result;
  honest limit when it matters; bans template, name, report-voice and
  marketing leads and truncation (same rules as `lintDiscoverHookV6`).
- `project.discover_partition` (required): `agent | skill | microservice |
  sandbox | none`, with exactly one matching canonical tag unless `none`;
  decided from what the product is, never from keywords.
- `project.time_to_first_value` (required): `minutes | hour | day | weeks` for
  a stranger, independent of the `experience` score.

Shipping it means updating the TS contract (schemas are exported from it),
`validate_artifacts.py`, the Mosoo skill snapshot and the Feed deploy gate.
That needs owner sign-off after the control-set review.

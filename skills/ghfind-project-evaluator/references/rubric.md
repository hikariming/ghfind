# Product-value rubric

## Non-negotiable rule

Score usefulness and product execution independently from popularity. Star, contributor count, company backing, release frequency, and marketing reach have zero positive weight in `product_score`.

## Product score: 100 points

### Pain: 25

Judge whether the problem is real, identifiable, and painful for the stated target user.

- 0–6: unclear, invented, or negligible problem.
- 7–13: real but infrequent, narrow, or already easy to solve.
- 14–20: clear recurring pain with meaningful friction.
- 21–25: severe or frequent pain with poor existing workarounds.

### Effectiveness: 30

Judge whether the implementation actually delivers the promised result.

- 0–7: mostly promise, demo, or broken core behavior.
- 8–16: partial solution with major gaps.
- 17–24: useful solution with manageable limitations.
- 25–30: reliably solves the core problem with strong evidence.

### Experience: 30

Judge discovery, installation, setup, defaults, first successful task, errors, and core interaction. Use the expectations for the selected project type.

- 0–7: core flow cannot be understood or completed.
- 8–16: substantial undocumented setup or confusing failures.
- 17–24: usable with some friction.
- 25–30: quick, coherent, forgiving path to value.

### Value density: 15

Judge user value relative to concepts, setup, operational burden, and scope. Do not reward size or complexity by itself.

- 0–3: complexity outweighs benefit.
- 4–8: acceptable trade-off with avoidable surface area.
- 9–12: focused scope and good value/cost balance.
- 13–15: unusually high value from a small or well-shaped surface.

## Confidence

Confidence represents evidence coverage, not quality. Start from the achieved verification level and reduce it for unverified promises, inaccessible demos, ambiguous identity, missing execution evidence, or conflicting signals. Missing information lowers confidence; it does not automatically lower a product dimension.

## Verification levels

- `metadata_only`: public metadata only.
- `source_inspected`: README, source, manifests, and examples inspected.
- `built`: dependencies or build completed in the sandbox.
- `core_flow_executed`: one representative user flow produced an observable result.

## Lifecycle

- `active_evolution`: frequent change is appropriate to the problem.
- `stable_maintenance`: mature and maintained without constant feature churn.
- `feature_complete`: the bounded problem is solved and needs little change.
- `experimental`: explicitly exploratory or unstable.
- `abandoned`: no longer fulfills its promise in the current ecosystem.

Do not punish a working feature-complete tool for low commit frequency or one maintainer. Do treat staleness as product evidence when the surrounding ecosystem changed enough to break the promise.

## Risk

License, security, supply-chain, maintenance, compatibility, privacy, and operations are separate adoption risks. They affect product score only when they directly break the product promise. A critical adoption risk prevents leaderboard admission but is not a popularity penalty.

## Exposure

Classify exposure relative to similar project type, age, and ecosystem:

- `unknown`: insufficient reliable data.
- `low`: clearly underexposed.
- `emerging`: receiving attention but not broadly adopted.
- `established`: sustained adoption.
- `mainstream`: head project with broad awareness.

Use logarithmic intuition for Star. Do not invent 30/90/180-day growth from a single snapshot.

## Community strength

Report a separate 0-100 `community_strength.score` from observable contributor depth, user support, dependents, issue responsiveness, and resilience signals. Missing data lowers confidence in this field instead of becoming a zero. This score never changes `product_score` and does not qualify a low-value project for either board.

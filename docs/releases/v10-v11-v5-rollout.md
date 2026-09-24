# v10 / v11 / v5 pronoun-aware roast wording

## Change

Roast v11 respects explicitly provided profile pronouns and uses neutral wording
when they are unavailable or unclear. New TS and Go collections include GitHub's
optional `User.pronouns` field in the existing contribution overview query.
Older snapshots remain valid and fall back to an explicit bio self-declaration
or neutral wording. This profile metadata never changes scoring or risk signals.

Only the roast artifact version advances. Score v10 and collection v5 remain
unchanged; no score backfill or database migration is required. The standalone
Go backend retains its existing collection version and also advances roast to v11.

## Rollout and verification

1. Deploy the application and version manifest together. Redis roast keys and
   archived-roast reads must require v11; v10 reports must not satisfy a normal
   v11 generation request. Existing reports are regenerated on demand, not in
   a bulk LLM job.
2. Verify explicit pronouns reach the writer through normal and degraded GitHub
   overview queries. A fresh scan is needed to enrich an older snapshot with the
   dedicated pronouns field; missing metadata must always use the neutral fallback.
3. Check English and Chinese writer inputs for pronoun evidence, neutral fallback,
   and the rule covering tags, top roast, and report. Keep profile text as data,
   never instructions. Compare scores with and without pronouns; they must match.
4. Preserve the previous v10/v10/v5 tuple only through the existing explicitly
   marked historical emergency-read path. Such historical text is not rewritten
   by this release and must not be presented as newly generated v11 wording.

## Rollback

Revert this release's code, cache constants, and manifest together and redeploy.
The prior report namespace remains available. Retain v11 artifacts; they need
not be deleted and will be usable after a corrected v11 deployment. Scores and
collection records are unchanged.

# Go Feed direct production release — 2026-09-09

The owner requested proceeding through Go Feed cutover and replaced the earlier
staging/canary prerequisite with direct production. This change preserves the
existing Feed D1 as the only authority. It does not certify the earlier seven
phases, remote capacity, cross-database recovery or semantic recall.

## Release contract

A clean exact commit must pass `python3 scripts/run-feed-e2e.py --release-sha
<40hex> --directory <fresh external directory> --execute` on **both** real local
profiles before every source push. The external OAuth/provider fixtures are
identified as fixtures. Their actual callback, finalization, source outbox,
executor, API, workerd/pgvector, object storage and deletion journeys must run;
no skipped dependency is a pass. Push and PR CI preserve their actual checkout
identities. Merge through a PR with rebase or merge commit, never squash.

After exact main CI, the Production environment workflow verifies the same CI
receipts and actual repository protection. The workflow then:

1. Builds Web with a public-only environment; no dotenv/runtime credentials.
   Builds the portable amd64 Go image and pushes it to obtain its immutable digest.
2. Reads the pinned production D1 databases; creates only the separately named
   production archive bucket and three bounded queues if absent. No production
   database is created, copied, promoted or deleted.
3. Applies only the file/hash approvals in `ops/feed-production-schema-release.json`.
   The dev/legacy application migration allowlist remains unchanged.
4. Installs the private adapter and off-mode runtime. Authenticated readback checks
   both actual Worker versions, bindings, each actual application image, basic
   sizes, instance limits (API 2 / executor 1) and all three Go readiness identities.
5. Publishes a 100% Go-only **paused** Web and enables source outbox. New assessment
   intent is persisted in the source database even while delivery is paused.
   Activates the database legacy-writer fence after the paused Web is read back.
   Old HTTP requests have no guaranteed wall-clock drain bound; triggers reject
   their remaining Feed DML. Adapter authorization markers exist only inside one
   atomic D1 batch and never remain after commit or rollback. Legacy user/catalog
   writers cannot be fallback.
   Subsequent releases pause an already-active Go Web before replacing its runtime.
6. Starts or resumes the one real assessment, then deploys baseline runtime with queue consumers and bounded source relay, then
   allows existing instances to idle before validating their **actual** Go mode.
   A Worker variable change alone cannot prove the container changed modes.
   Requires real assessment finalization and queue projection, then bounded
   authenticated service-contract smoke with nonempty eligible candidates.
7. Publishes the same Web build in `all` mode and reads back its runtime binding,
   source SHA, production D1, outbox flag, secrets inventory and all routing vars.
   Public smoke runs at the WAF-free production workers.dev origin. The custom
   domain and actual OAuth Feed journey are also checked in the holder browser.

Independent staging workflows stay isolated and cannot accept production IDs.
No local `wrangler deploy` is part of the production release path. Deployment,
resource changes, migrations and containment are serialized in GitHub Actions.

## Compatibility and containment

See `feed-production-compatibility-20260909.md` for real workerd counterexamples.
Before the first Go write the additive migrations preserve legacy table columns.
After Go writes, old Next writes can violate privacy generations and return false
completed deletion. Rolling back to `aa8c683` or setting `FEED_BACKEND=legacy` is
therefore forbidden. The first-release rollback anchor is the verified new Web
in paused mode with the same D1 and writer contract. It protects data and the
other site functions but returns Feed 503: it is **containment**, not a successful
Feed availability recovery or a <=5-minute recovery acceptance. After a compatible
Go release has itself passed live validation, preserve its immutable image and
Worker manifest as a service-recovery anchor. Never reverse destructive schema.

If deployment fails before Web cutover, do not declare success. If cutover or
public smoke fails after the paused anchor is captured, the workflow restores
that anchor and reads it back. A retry cannot return to a legacy writer. Failed
runs and actual state receipts are retained for 30 days, without secret values.

## Production catalog and real provider

The initial readback was 261 projects / 235 published flags, and zero Feed users,
events and served items. Core migration 0005/0006 and Feed 0003–0012 were absent.
Published historical flags do not establish submission provenance. Keep such
projects out of Go candidates until real app submission or individually verified
historical evidence exists; never bulk approve the 1,169 pending tag proposals.
All 286 completed source runs observed on 2026-09-09 use historical analysis
schema v2 / agent v2 / skill v3. None satisfies the current v3 / v3 / v4 contract.
This release therefore submits `hikariming/ghfind` at its exact release SHA through
the public application API once and requires actual Mosoo artifacts, finalization,
source receipt/outbox, durable job and eligible Feed projection before opening
traffic. The one logical assessment may make at most two failed retries; provider
attempts are reported separately from logical submission count. A durable intent
receipt is uploaded even on failure and restored from prior Actions attempts.
An uncertain POST is reconciled against the source database, never blindly sent
again. A missing prior receipt after a possible POST fails closed. Future releases
may reuse a genuinely eligible existing projection, explicitly reporting reuse.

A new published Mosoo project agent `01M22PWZR0A7ZYCDKWTEA0YEHQ` was provisioned
using the owner's StepFun credentials. Initially named `ghfind-feed-staging`, it
is assigned to this direct production release; the isolated staging Web has not
been deployed. Production uses `MOSOO_PROJECT_USER_ID=ghfind-production`. Runtime
provider token and eight independent Feed role secrets are stored in GitHub's
Production environment. Existing Web OAuth secrets remain Cloudflare-owned and
are preserved by Wrangler's secrets-file/keep-vars deploy behavior. The production
CF token is scoped to Beiming's account with Workers Scripts, D1, R2, Containers,
Queues and Cloudchamber edit; the token value was not exported when its permissions
were updated. No account cookie or personal OAuth session is uploaded to Actions.

## Cost and evidence boundaries

Workers Paid/Containers access was confirmed in the Beiming dashboard. Current
[Container prices](https://developers.cloudflare.com/containers/platform/pricing/)
were checked on 2026-09-09. The conservative rate-card scenario is $79.69848/month:
three basic instances active 730 hours with all allocated CPU utilized, plus the
same three staging instances for 40 hours, $5 Workers base and $10 assumed other
services. Shared-account allowances are not deducted. This is an **unmeasured
planning scenario**, not a billing cap or proof of actual workload cost. Semantic
recall remains disabled. The $100 approved budget leaves $20.30152 against this
scenario; logs, D1/R2 operations, queue deliveries and egress still require actual
usage review. Remote p95, fault recovery and monthly availability remain separate
acceptance items. No production load test is authorized by this direct cutover.

## Evidence handoff

The release artifact `feed-production-<run>-<attempt>` contains resource IDs,
applied schema, off and baseline authenticated runtime receipts, paused and all
Web receipts, and any containment receipt. Authorization artifacts contain exact
CI and protection readbacks. Link the precise SHA, image digest, actual Worker
versions, public smoke and holder-browser OAuth/business evidence in the PR and
final handoff. Distinguish automated signed service-contract smoke from the real
OAuth journey. Empty candidates, missing browser evidence or no actual queue
projection cannot be reported as a completed business acceptance.

# Feed stage 1 runtime/platform handoff

Base: `3cdb66cc21028e1b7159ce30f769ff8fcd9b4d33` (merged storage foundation).
This PR delivers independent Go API/executor entrypoints and a shared portable
image, private Cloudflare binding transports, fixed-capacity Container routing,
exact-source staging deployment and operator recovery tooling. It leaves existing
production routing and its approved migration manifest unchanged.

The three implementation commits respectively own Go binaries/images, the CF
runtime/binding layer, and CI/deployment. Local Docker and resource evidence is
recorded separately. Public/storage/executor contract version is 1; Feed D1 is
schema 7 and PostgreSQL is through 0019 in this PR. The isolated source adapter
needs additive core migrations 0005/0006. They supply the source capability and
replay storage for platform testing; the Next assessment finalization seam is
not changed here and remains stage 4. The legacy production/dev deploy allowlist
does not apply those new core migrations.

Both binaries are in the same scratch/nonroot image with independent entrypoints.
Only the API receives gateway/signing credentials. Only the executor receives
source/executor credentials; role-specific outbound allowlists bound storage
operations. Operator, delivery and runtime administration credentials stay in
Workers. API population is fixed at two slots, executor at one; arbitrary names
cannot expand it. No old RabbitMQ/scoring/scanning loop is started.

The source relay, replay dispatcher and cleanup scheduler are independent awaited
branches. Queue acknowledgements follow durable outcomes; terminal failures are
recorded before acknowledgement and have a separate 14-day parking queue when
that write also fails. These are implementation and local fault-test results;
actual remote Queue failures and alert delivery still require staging evidence.

## Verification and boundaries

- [Docker lifecycle evidence](../evidence/feed-docker-0c23f3b/README.md): same image
  runs without Next/CF, readiness and anonymous 401, graceful SIGTERM, restart,
  actual tmpfs loss and bounded concurrency. It tests API build 0c23f3b, not the
  newer executor archive-readiness implementation or a pushed registry digest.
- The merged storage foundation has real pgvector/MinIO and workerd contracts.
  This PR adds runtime identity, size limits, outbound roles, queue failures,
  private operations, manifest isolation and active-deployment readback checks.
- [Actual staging resources](../audits/2026-09-08-feed-staging-resources.md) exist
  separately from all known production/dev databases. No business writes,
  Worker/Container deployment or production traffic is established by that audit.
- The Actions token's final creation is pending approval in the authenticated CF
  browser flow. Repository environment management separately returns 403/404;
  merge bypass has succeeded. Do not infer settings authority from merge success.
- The example staging manifest intentionally fails validation until actual
  isolation, budget and credential evidence is configured. Cost output is an
  unmeasured scenario, not metered acceptance or a billing hard cap.

The staging workflow requires CI success for the exact requested SHA, builds and
pushes the image first, records its digest, deploys the private adapter and then a
Worker referencing that digest. It probes actual container versions/readiness
and captures readback. A prebuilt digest does not make Worker/Container rollout
transactional. The recovery workflow fails closed if its operations environment
is not actually protected; this PR does not claim that environment exists.

Stage 1 acceptance remains open until ordinary Docker and actual CF staging run
the same published image and the latency, lifecycle, failure and cost gates pass.
No fallback to Railway is justified by the current permission/configuration gaps.
Stage 5 must wait for this evidence and stages 3/4. Formal releases and recovery
use Actions. Application rollback keeps the same fact source; no destructive
migration reversal or local production deploy is provided here.

The code foundation can merge after its own CI passes so the staging workflow is
available on the default branch. This is not stage-1 operational acceptance.
Initial PR #248 CI passed on `a9c94f4`; a subsequent isolated recovery drill found
that pending physical cleanup allowed old impressions into a newly created
profile. The independent fix now joins request ownership and the preserved
profile floor. New-head CI and its real workerd regression are required before
merging this update. Remote runtime activation still requires the reviewed
staging manifest and all remaining evidence above.

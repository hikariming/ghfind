# Production runtime bootstrap contract

The production renderer is separate from staging. `scripts/feed-platform-production.mjs`
accepts only account `8f19bebe359e4ec1a24c68c5f49c1584`, the existing core D1
`ghfind` (`60d45096-bfe7-4de1-8b85-c1b66a466b0d`) and Feed D1 `ghfind-feed`
(`9c4ac13a-4c90-40a8-9d56-d7141f864bbf`). Its other names and runtime origin
are pinned by `template`. The staging production/dev denylist is unchanged.

This code renders configuration and performs bounded GET requests. It does not
provision resources, apply schemas, set secrets, deploy a Worker, change traffic,
run OAuth, sign a user request or write business state. Formal changes remain
serialized GitHub Actions operations owned by the release workflow. The complete
local dual-profile E2E and successful exact-source push CI remain prerequisites.
An explicit authorization to omit standalone staging does not satisfy those gates.

## Interface for the release workflow

```text
node scripts/feed-platform-production.mjs template
node scripts/feed-platform-production.mjs validate MANIFEST
node scripts/feed-platform-production.mjs render MANIFEST SHA IMAGE off
node scripts/feed-platform-production.mjs verify MANIFEST SHA IMAGE off OFF_RECEIPT
node scripts/feed-platform-production.mjs render MANIFEST SHA IMAGE baseline OFF_RECEIPT
node scripts/feed-platform-production.mjs verify MANIFEST SHA IMAGE baseline BASELINE_RECEIPT
```

`SHA` is 40 lowercase hex characters; `IMAGE` is the pinned account's
`ghfind-feed@sha256:<64hex>` registry reference. No mutable tag or semantic mode
is accepted. The manifest includes a positive safe `writerEpoch`, confirmed paid
plan evidence, a planning estimate at or below USD 80 and maximum budget USD 100.
A planning estimate is not metered cost or a hard platform spending cap.

Both render commands write only ignored files:

- `platform/runtime/wrangler.production.generated.json`
- `platform/runtime/wrangler.adapter.production.generated.json`

The adapter config lives under runtime so its `main` is `../feed/src/index.ts`.
Both migration directories remain relative to this config, but render never
applies them. The adapter is private, has no preview URL, and keeps semantic
state disabled. Both deployments must receive `--tag production-${SHA}`;
readback verifies that annotation together with exact version IDs and binding
values. The API has two `basic` slots and the executor one. Executor idle remains
10 seconds, API idle two minutes. No request-provided instance identifier exists.

The workflow supplies seven independent runtime secrets exported as `secretNames`:
`FEED_GATEWAY_SECRET`, `FEED_SIGNING_SECRET`, `FEED_BRIDGE_SECRET`,
`FEED_RUNTIME_ADMIN_SECRET`, `FEED_EXECUTOR_SECRET`, `FEED_SOURCE_SECRET`,
`FEED_DELIVERY_SECRET`. The five adapter roles exported as `adapterSecretNames`
are bridge, source, executor, delivery and `FEED_OPERATOR_SECRET`. Production
values must be distinct from staging. The operator role never enters a Container
or a runtime environment binding. Readback uses `FEED_RUNTIME_ADMIN_SECRET` for
runtime HTTP and `CLOUDFLARE_API_TOKEN` for metadata. The child CLI receives only
the metadata token and basic process paths; its raw stdout/stderr is never logged
or saved as evidence. Secrets never belong in manifests, command-line arguments,
receipts or build-time frontend environment variables.

## Serial activation and compatibility

1. The release owner verifies actual D1 schema/writer compatibility, completes
   any approved writer fence and serial migrations, provisions or verifies the
   pinned archive/queues, applies distinct credentials, and publishes an
   immutable image. Existing legacy Next Feed writes are incompatible with
   writer contract 2 and must be fenced before schema/write activation.
2. Deploy the private adapter and initial `off` runtime. This config permits
   authenticated dependency readiness but registers no cron or queue consumers;
   source relay is disabled. It is an initial bootstrap mode, not a rollback
   configuration for a service that has already accepted durable tasks.
3. After normal bounded provisioning wait, call `verify ... off`. A passing
   receipt gates rendering baseline, expires after 15 minutes, and is bound to
   the same manifest, SHA, image, writer epoch and Actions run/attempt. The
   receipt is a trusted workflow artifact, not a cryptographically signed
   assertion; do not import an untrusted file as authority.
4. Deploy baseline. A changed Worker and unchanged image digest do not prove
   existing Go processes reloaded their environment. With Web admission paused,
   stop readiness traffic and leave a bounded idle interval greater than two
   minutes (for example 125 seconds). Do not repeatedly ping an old off process:
   each ping would postpone its idle termination. Production stop is disabled.
5. `verify ... baseline` must observe actual Go `mode=baseline`, current SHA,
   writer 2, contract 1, `cf_d1_r2` and exact epoch on all three fixed targets.
   Failure leaves Web admission closed. A passing **off** receipt cannot prove
   the baseline deployment completed. Only the separately read-back baseline
   can precede Web admission, bounded production smoke and the real journey.

Readback performs at most 13 metadata reads and 75 authenticated readiness
requests within 180 seconds. Each metadata operation has a 30-second timeout;
readiness has a 10-second timeout. Initial readiness failure fails this attempt;
it is not an unbounded provisioning loop. While metadata runs asynchronously,
readiness runs every 2.5 seconds to keep the executor alive. The heartbeat and
owned metadata child are aborted/joined on every exit. There is no lasting
keep-warm configuration change or lifecycle stop.

The verifier checks both Workers' active 100% versions before and after the
inspection, exact release tags and bindings, private adapter/public runtime
exposure, immutable Container applications, actual `basic` capacity caps, the
runtime Durable Object namespace association, and running instance names/versions.
Evidence uses explicit whitelists, including the final readiness response.
Caller-supplied raw JSON, environment values, provider errors and extra metadata
are excluded. An application inventory page that omits the required applications
fails; the verifier does not guess unseen resources or scan the entire account.

Production public `/healthz` returns liveness without SHA or Worker ID. Detailed
readiness needs the runtime admin bearer. Bounded operator `status`, governance
`proposal` and `command` reads additionally require the separate operator token
and exact contract/production target/SHA/epoch headers. Review, deprecate and
replay require baseline; no arbitrary SQL/path/body capability is added.

## Evidence boundary and local checks

```text
node --test scripts/feed-platform-production.test.mjs
npm test --prefix platform/runtime
npm run typecheck --prefix platform/runtime
```

Tests use synthetic metadata and dispatch responses, including an 11-second
metadata delay that exceeds executor idle, epoch/mode/version drift, wrong D1,
changed Worker, wrong application namespace, expanded capacity, expired receipts,
secret-bearing extra fields, and cancellation. Wrangler 4.129.1 dry-run builds
validate generated runtime and adapter configuration without a remote mutation.

These checks do not prove actual CF deployment, queue consumer/parking policy,
real OAuth/assessment, production Feed journeys, recovery, database promotion,
load/cold SLO, monthly cost or availability. The workflow must separately verify
queue/DLQ/parking configuration (including 14-day parking without an automatic
consumer), source outbox delivery, and the authorized production smoke. A previous
compatible Go program on the same fact source is the application rollback path;
legacy Next Feed or a backward schema migration is not.

Current references: [nontransactional deployment](https://developers.cloudflare.com/containers/guides/deploy/),
[rollouts](https://developers.cloudflare.com/containers/configuration/rollouts/),
[service bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/).
CLI response shapes are checked against the pinned Wrangler 4.129.1 implementation.

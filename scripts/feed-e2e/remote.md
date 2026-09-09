# Real isolated Cloudflare acceptance journey

Run only through `Feed isolated staging` GitHub Actions after complete local
dual-profile E2E and accurate checkout CI pass. The CLI rejects local execution,
other repositories, unpinned D1 targets and another checkout SHA. The workflow
owns the staging environment lock for deployment, testing and final readback.

```sh
node scripts/feed-e2e-remote.mjs --manifest MANIFEST --release-sha SHA --directory FRESH_ABSOLUTE_DIRECTORY --execute
```

The v2 manifest and preparation instructions are in
[`platform/runtime/staging-web.md`](../../platform/runtime/staging-web.md).
Required private runtime inputs are `CF_FEED_STAGING_API_TOKEN`,
`FEED_RUNTIME_ADMIN_SECRET`, `FEED_OPERATOR_SECRET`, and two mode-0600 GitHub-only
holder storage-state files selected by
`FEED_E2E_ORDINARY_STORAGE_STATE_FILE` and
`FEED_E2E_GOVERNANCE_STORAGE_STATE_FILE`.
The workflow writes those files from its environment secrets and removes them
on success or failure. Never commit, attach to a PR, or publish these values.

Both account holders first authenticate to GitHub and approve the dedicated
OAuth App. Every acceptance attempt then follows the actual authorize redirect,
provider exchange and application callback to obtain a new HttpOnly application
session. Existing application cookies, other domains, expired login, unfinished
consent, MFA or challenges fail the gate. The runner never signs a login cookie
or clicks through an account security challenge.

## Bounded real business writes

The runner inspects the active immutable Web version's complete bindings before
any browser write. Source and Feed databases, cache, runtime service, OAuth App,
provider and identity/repository allowlists must match the isolated manifest.
The same Web version must still be active at the end.

Only the two dedicated test identities and the first approved repository are
used. The attempt is limited to one real assessment, 25 minutes, 450 runner
requests and 16 D1/platform management calls. It exercises the actual source
HTTP API, finalization transaction, scheduled outbox relay, CF queue, Go
executor, governance, Feed, explicit preferences, behavior events and completed
deletion. No mock providers, manual queue drain, or direct Feed projection writes
are present. Exact analysis, event, receipt, sequence and source hashes are read
back from both databases; a visible old project or superseded job cannot pass.

A repeat attempt must create a fresh assessment instead of reusing an old
summary. Its sole maintenance write conditionally removes the approved staging
repository's current `project_assessments` summary pointer after verifying that
the previous dedicated-agent run, outbox and executor completed. Active work or
ownership mismatch stops the attempt. Immutable analysis history, receipts,
outbox watermarks, Feed state and deletion fences are preserved. This bounded
fixture operation uses the D1 API inside Actions; it does not add runtime SQL RPC.

The review maps a user proposal onto an existing approved canonical tag. Its
audit operator is bound to the independently authenticated governance identity;
an invalid operator credential is rejected. Save and outbound must increase the
actual behavior profile; duplicate outbound must leave its strength and version
unchanged. Negative preference filtering must disappear when cleared.

Profile deletion must reach `completed`. Other users cannot read that deletion
and an old impression token cannot write afterward. The runner removes any empty
new profile created by the stale-token probe. A partial failure retains a failed
receipt and never claims successful cleanup; a subsequent attempt clears only
the dedicated identities before starting.

## Evidence limits

`feed-e2e-remote.json` includes exact source/tree and observed Web version,
milestones, dedicated identity names/IDs, hashed analysis/event identifiers,
source sequence, bounded counters, and sanitized failure codes. OAuth URLs,
codes, state, cookies, provider bodies and personal behavior payloads are excluded.
The final staging verifier binds this to current-run CI, build, actual Containers
and final Web readback. Failed attempts remain available without a passing
release receipt.

This stage does not prove nonempty archive-object removal, R2 recovery, CF queue
failure/DLQ behavior, sustained performance, cold-start SLOs, measured monthly
cost or migration/production readiness. Those remain stages 2–5 acceptance gates.

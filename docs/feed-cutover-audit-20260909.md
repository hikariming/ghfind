# Production cutover audit, before another release

Baseline: `ede8cad840624229563dcb043261f244615b1635`.
Run `34366035791` stopped before Web replacement, writer fencing or assessment.
Direct Application details showed version 10/the new digest; all 19 aggregate
readiness requests returned HTTP 200 with the expected Go source and mode.
Dashboard instance summaries nevertheless reported `api-0` stopped for eight
reads. Earlier runs had the same mismatch for application summary versions.
Those observations are failures of the old gate, not evidence of full cutover.

## Root causes and complete corrective scope

| Boundary | Finding | Resolution and counterexample |
| --- | --- | --- |
| Application identity | Dashboard summaries can lag direct application details | Keep direct immutable ID/image/version/namespace/capacity checks and final pins. Wrong or regressing identities still fail. |
| Running instances | Pinned Wrangler `containers instances` also reads dashboard summaries | Use native state captured inside each fixed DO after actual Go readiness. Wrong/duplicate actors, stopped processes and invalid readiness fail. Dashboard availability/state no longer decides process health. |
| Same-SHA rebuild | Compiled source SHA alone cannot distinguish two image builds | Compile a new random build ID, inspect both entrypoints from the built image, bind them to the pushed digest/run/attempt, require the actual Go responses to match. No expected value is copied into Go's response. |
| Provider → relay | Adding baseline Cron can take up to 15 minutes to propagate | Persist a separately bounded relay bootstrap before the normal queue projection deadline. An already-delivered source cannot obtain that extra allowance. |
| Existing projection | A coherent older projection may be visible while a new event waits | Permit only strictly lower source versions as pending. Same-version identity mismatch, future versions and terminal execution remain failures. |
| Web identity | A correct tag could hide a wrong UUID/staging service, missing ISR bucket/assets or missing OAuth configuration | Check immutable UUID, unique bindings, exact production R2/assets, preserved OAuth secret inventory, and final deployment pins. Actual current CF response shapes were read before adding these checks. |
| Receipt consumption | A generated pass receipt could lose IDs, budgets or queue policies yet still authorize baseline | Validate complete v2 Worker/application identity, native actor linkage, numeric budgets, queues and schedules; malformed or truncated receipts fail. |
| Interrupted admission | `failure()` alone misses cancelled deployment/smoke steps | Record intent before all-mode mutation. Restore the captured Go-only paused anchor whenever admission began but smoke did not pass, within a three-minute step (120s rollback/30s readback with 5s kill grace). Retain an attempted-unverified receipt first; runner loss still needs the protected recovery workflow. |
| Public route coverage | Runtime service signatures do not prove Web routing or real OAuth | Add anonymous/forged-identity Web Feed checks; retain a separate holder-browser authenticated check. Never label signed service fixtures as OAuth evidence. |

Wrangler 4.129.1's legacy native deployment APIs use `/cloudchamber`, whereas
the supported Containers commands use `/containers`. Read-only investigation
returned 401 for the former and 200 for the dashboard route. This is an
unavailable diagnostic API, not proof that an instance or permission is absent.
It is not added as another release dependency. Local protected readiness also
returned transport/WAF 403 and was not counted as a Go failure or success.

## Validation before pushing

The corrective PR must include native identity and old-build counterexamples,
both actual image entrypoint inspections, relay/resume/exhaustion scenarios,
old-project projection scenarios, strict Web binding/UUID checks and cancelled
admission conditions. Preserve failed evidence. Run the complete local dual
profile E2E at the clean final commit before pushing, then exact branch/PR CI,
rebase merge, exact main CI and the serialized production workflow.

Independent review covered the source finalization/outbox transaction, adapter
writer contexts, baseline queue envelopes, fixed public canonical origin and
Go-only paused rollback. No production source row was inserted for testing.
Only the final remote run can establish actual provider artifacts, queue
execution and production service binding behavior. The original capacity,
recovery, migration and semantic quality acceptance remain separate.

References: [Containers rollouts](https://developers.cloudflare.com/containers/configuration/rollouts/),
[native Container running state](https://developers.cloudflare.com/durable-objects/api/container/#running),
[Cron propagation](https://developers.cloudflare.com/workers/configuration/cron-triggers/#2-update-configuration).

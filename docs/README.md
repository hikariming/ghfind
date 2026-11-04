# ghfind documentation

Start with the [System overview](./architecture/overview.md). Product rules and
contributor constraints live in the repository root [`AGENTS.md`](../AGENTS.md);
when a document and the code disagree, the code and AGENTS.md win, and the
document should be fixed.

## Understand the system

| Document | What it covers |
| --- | --- |
| [architecture/overview.md](./architecture/overview.md) | Code modules, production Workers, a score request end to end, where to change things |
| [architecture/open-core-split.md](./architecture/open-core-split.md) | Public scoring vs. private backend, cross-repo CI/CD, cutover runbook |
| [rfc/2026-10-15-account-scoring.md](./rfc/2026-10-15-account-scoring.md) | Account scoring design: dimensions, risk policy, versioning |
| [scoring/super-newcomer.md](./scoring/super-newcomer.md) | Super-newcomer maturity bonus: rule and limits |
| [adr/001-portable-feed-runtime.md](./adr/001-portable-feed-runtime.md) | Why the Feed runtime is portable Go with D1/R2 or PostgreSQL storage |
| [design/research-icons.md](./design/research-icons.md) | Deep Research article imagery |

## Develop

| Document | What it covers |
| --- | --- |
| [development/local-accounts.md](./development/local-accounts.md) | `pnpm run init`, local test identities, signed-in browser sessions |
| [development/cli.md](./development/cli.md) | The Go `ghfind` CLI: build, credentials, updating |
| [`scoring/README.md`](../scoring/README.md) | Working on the public scoring module (TS, Go, Python parity) |
| [`platform/github-app`](../platform/github-app/README.md) | ghfind Review GitHub App |

## Operate

| Area | Documents |
| --- | --- |
| Deployment | [Cloudflare deployment runbook](./operations/cloudflare-deployment-runbook.md) · [deployment smoke](./releases/deployment-smoke.md) · [release capacity defaults](./releases/release-capacity-defaults.md) |
| Scores | [score cache protection](./operations/scan-cache-protection.md) · [canonical score backfill](./operations/canonical-score-backfill.md) |
| Content | [curated collections](./operations/collections.md) · [curated X timeline](./operations/x-timeline.md) · [Social Feed](./operations/social-feed.md) · [DeepSeek jobs check](./operations/deepseek-jobs-2026-10-13.md) |
| Sign-in | [Google sign-in](./operations/google-signin.md) |
| Project Feed | [Cloudflare-native Feed runbook](./operations/project-feed-backend-runbook.md) · [operator runbook](./operations/feed-operator-runbook.md) · [production pause](./operations/feed-production-pause.md) · [backup and restore](./operations/feed-backup-restore.md) · [platform prerequisites](./operations/feed-platform-prerequisites.md) · [GitHub release protection](./operations/feed-github-protection.md) |
| Feed governance | [taxonomy](./operations/feed-taxonomy-governance.md) · [PostgreSQL](./operations/feed-postgres-governance.md) · [user proposal erasure](./operations/feed-user-proposal-erasure.md) · [0015 partition tags](./operations/feed-0015-partition-tags-operator.md) |
| Feed capacity and recovery | [Docker HTTP portability](./operations/feed-docker-http-portability.md) · [Linux capacity](./operations/feed-linux-capacity.md) · [local capacity](./operations/feed-local-capacity.md) · [local recovery evidence](./operations/feed-local-recovery-evidence.md) · [query diagnosis](./operations/feed-query-diagnosis.md) · [assessment recovery](./operations/feed-assessment-operator-recovery.md) |
| Alerts | [`backend-alerts.prometheus.yml`](./operations/backend-alerts.prometheus.yml) |

## Contracts and records

- [`contracts/`](./contracts) — versioned Feed API, transfer, rollout, governance and session-identity contracts (fixtures are read by tests).
- [`releases/`](./releases) — release notes and rollout records, named `v<score>-v<roast>-v<collection>-*` (see `config/release-versions.json`), plus Feed phases.
- [`audits/`](./audits) — dated audits (Feed platform, cutover, staging resources, Turso history).
- [`evidence/`](./evidence) — raw evidence bundles referenced by releases and audits. Do not edit.
- [`pr-assets/`](./pr-assets) — screenshots attached to pull requests.
- [`archive/`](./archive) — completed plans and retired runbooks. Historical only; do not operate from them.

## Writing docs

- Put a document in the folder for its purpose (above); avoid new files in `docs/` root.
- Link code by repository-relative path and keep facts checkable against the code.
- Mark superseded documents at the top and move them to `archive/` instead of editing history.
- Update this index when you add, move or retire a document.

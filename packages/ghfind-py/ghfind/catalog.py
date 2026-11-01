"""Machine-readable catalog of ghfind's atomic capabilities.

Mirrors the JS SDK catalog and /openapi.json so an agent can introspect what the
SDK does — including whether a capability is deterministic or uses an LLM.
"""

from __future__ import annotations

from typing import List, TypedDict

DEFAULT_HOST = "https://ghfind.com"


class Capability(TypedDict):
    method: str
    api: List[str]
    summary: str
    llm: bool
    response_semantics: str
    agent_guidance: str


CATALOG: List[Capability] = [
    {
        "method": "get_score",
        "api": ["GET /api/score/{username}"],
        "summary": "Fetch the deterministic score for any GitHub account.",
        "llm": False,
        "response_semantics": (
            "Factual score payload: final_score, tier, six-dimension sub_scores, and v10 "
            "risk_assessment/risk_notes. Never calls an "
            "LLM. Indexed accounts return stored data (source indexed); unseen accounts are "
            "admitted to the Go quick-scan worker path (source quick, coverage quick, includes "
            "red_flags). Compatible old stored scores may return source legacy_v5_v5_v3 with "
            "stale true. 404 only if the GitHub login does not exist."
        ),
        "agent_guidance": "Preferred first call — works even for accounts never seen before. Use scan() when you also need full metrics.",
    },
    {
        "method": "get_github_user / user_exists",
        "api": ["GET https://api.github.com/users/{username}"],
        "summary": "Confirm a GitHub account exists (client-side, via GitHub's own API).",
        "llm": False,
        "response_semantics": (
            "Basic public GitHub profile, or None if the login does not exist. Runs on the "
            "caller's IP/quota, NOT ghfind's. No token needed (optional token raises the anon limit)."
        ),
        "agent_guidance": (
            "Validate a handle before spending a scoring call. Pass verify_exists=True to "
            "scan()/get_score() to do this automatically and fail fast on typos."
        ),
    },
    {
        "method": "scan",
        "api": ["POST /api/scan"],
        "summary": "Crawl GitHub and compute the full deterministic scan + score.",
        "llm": False,
        "response_semantics": "Authoritative factual payload: metrics, signals, sub_scores, v10 risk_assessment, risk_notes, red_flags, final_score.",
        "agent_guidance": "Use for full evidence or your own analysis. Source of truth for scoring facts.",
    },
    {
        "method": "score",
        "api": ["POST /api/scan"],
        "summary": "Compact scoring block derived from scan().",
        "llm": False,
        "response_semantics": "Just the scoring object (numeric score, tier, six sub_scores, v10 risk_assessment, risk_notes, red_flags).",
        "agent_guidance": "Use when you only need the numbers.",
    },
    {
        "method": "roast",
        "api": ["POST /api/scan", "POST /api/roast"],
        "summary": "Generate the human-facing roast report + AI-adjusted score.",
        "llm": True,
        "response_semantics": "Presentation report: markdown, tags, roast_line, meta. LLM may adjust score by ±10.",
        "agent_guidance": "Only for the human-facing report. Use scan/score/get_score for facts. Pass byo_key for your own model.",
    },
    {
        "method": "vs",
        "api": ["POST /api/vs-verdict"],
        "summary": "Head-to-head verdict for two scored accounts.",
        "llm": True,
        "response_semantics": "Winner + bucket are deterministic; verdict/advice prose is LLM and may be null.",
        "agent_guidance": "Both accounts must already be scored. Winner is reliable even when prose is null.",
    },
    {
        "method": "leaderboard",
        "api": ["GET /api/leaderboard"],
        "summary": "Ranked public profiles (Hall of Fame / trending / heat / progress).",
        "llm": False,
        "response_semantics": "Cached ranking/discovery entries.",
        "agent_guidance": "Use to discover candidates. For a specific user, call scan/score/get_score.",
    },
    {
        "method": "developers",
        "api": ["GET /api/developers"],
        "summary": "Discover developers by language, organization, or contributed repo.",
        "llm": False,
        "response_semantics": "Cached discovery categories or entries for a facet.",
        "agent_guidance": "Use to find candidates by facet. Verify a specific account afterward.",
    },
    {
        "method": "search_users",
        "api": ["GET /api/search-users"],
        "summary": "Prefix autocomplete over scored accounts.",
        "llm": False,
        "response_semantics": "Up to 6 matching scored users.",
        "agent_guidance": "Use to resolve a partial handle.",
    },
    {
        "method": "stats",
        "api": ["GET /api/stats"],
        "summary": "Platform totals (number of scored accounts).",
        "llm": False,
        "response_semantics": "Aggregate metadata, not a per-user source.",
        "agent_guidance": "Platform overview only.",
    },
    {
        "method": "badge_url / card_url / vs_card_url",
        "api": ["GET /api/badge/{username}", "GET /api/card/{username}", "GET /api/card/vs/{a}/{b}"],
        "summary": "Build image URLs (SVG badge, OG PNG cards). Pure — no request.",
        "llm": False,
        "response_semantics": "Returns a URL string.",
        "agent_guidance": "Embed a badge in a README or a card in a share preview.",
    },
    {
        "method": "bot status",
        "api": ["GET https://bot.ghfind.com/api/v1/repos/{owner}/{repo}"],
        "summary": (
            "CLI only: `ghfind bot status <owner/repo>`. Settings, recent and failed jobs, the latest "
            "cleanup and the audit log of the ghfind Review GitHub App on one repository."
        ),
        "llm": False,
        "response_semantics": (
            "Requires a personal API token with the bot permission: select Manage the ghfind Review bot at https://ghfind.com/integrations when creating it. Existing tokens remain scan-only. Needs write access to the repository; "
            "viewer.admin says whether you may change anything. Errors are {error: code}: "
            "invalid_token, token_scope_required, not_found (App not installed, no such repository, or no write access), admin_required, rate_limited."
        ),
        "agent_guidance": (
            "First call when a user reports a problem with the bot on their repository. Check "
            "settings, jobs.failed and cleanup before acting."
        ),
    },
    {
        "method": "bot settings get / bot settings set",
        "api": ["GET|PATCH https://bot.ghfind.com/api/v1/repos/{owner}/{repo}/settings"],
        "summary": (
            "CLI only: `ghfind bot settings set <owner/repo> [--issues on|off] [--prs on|off] "
            "[--comments-enabled on|off] [--triage on|off] [--prompt TEXT] [--allowed-labels a,b]`. "
            "Changes only the given switches. Admin only."
        ),
        "llm": False,
        "response_semantics": (
            "Requires a personal API token with the bot permission: select Manage the ghfind Review bot at https://ghfind.com/integrations when creating it. Existing tokens remain scan-only. Returns the saved settings. --allowed-labels must name existing repository labels; "
            "review: labels are rejected."
        ),
        "agent_guidance": "Change one switch at a time and confirm the user asked for it.",
    },
    {
        "method": "bot pause / bot resume",
        "api": ["POST https://bot.ghfind.com/api/v1/repos/{owner}/{repo}/pause", "POST .../resume"],
        "summary": (
            "CLI only: `ghfind bot pause <owner/repo>` turns off issue and PR processing and cancels "
            "queued jobs; `resume` turns both back on. Admin only."
        ),
        "llm": False,
        "response_semantics": "Requires a personal API token with the bot permission: select Manage the ghfind Review bot at https://ghfind.com/integrations when creating it. Existing tokens remain scan-only. Returns the settings; pause also returns cancelled_jobs.",
        "agent_guidance": "Pause before a cleanup, otherwise new issues and PRs are labelled again while it runs.",
    },
    {
        "method": "bot backfill / bot retry",
        "api": ["POST https://bot.ghfind.com/api/v1/repos/{owner}/{repo}/backfill", "POST .../retry"],
        "summary": (
            "CLI only: `ghfind bot backfill <owner/repo> [-n 25]` queues the newest open items "
            "(1-100, one backfill at a time); `ghfind bot retry <owner/repo> [job-id]` requeues "
            "failed jobs. Admin only."
        ),
        "llm": False,
        "response_semantics": "Requires a personal API token with the bot permission: select Manage the ghfind Review bot at https://ghfind.com/integrations when creating it. Existing tokens remain scan-only. 202 on success; backfill_busy (409) while a backfill is pending or running.",
        "agent_guidance": "Use retry after fixing the cause shown in `bot status` jobs.",
    },
    {
        "method": "bot cleanup / bot cleanup confirm / bot cleanup status / bot cleanup cancel",
        "api": [
            "POST https://bot.ghfind.com/api/v1/repos/{owner}/{repo}/cleanups",
            "GET .../cleanups/{id}",
            "POST .../cleanups/{id}/confirm",
            "POST .../cleanups/{id}/cancel",
        ],
        "summary": (
            "CLI only: `ghfind bot cleanup <owner/repo> [--labels review|triage|all] [--comments] "
            "[--delete-label-definitions]` previews what the bot would remove and returns a confirm "
            "token; `ghfind bot cleanup confirm <owner/repo> <token> [--wait]` executes it. Admin only."
        ),
        "llm": False,
        "response_semantics": (
            "Requires a personal API token with the bot permission: select Manage the ghfind Review bot at https://ghfind.com/integrations when creating it. Existing tokens remain scan-only. Removes only what the bot wrote: review: labels, intent labels the bot recorded applying, "
            "and its own marked comments. Label deletion rechecks the latest exact-name event actor; unknown history is preserved. "
            "Review definitions are deleted only when unused. Intent label "
            "definitions are never deleted. The preview changes nothing; the token expires 10 minutes "
            "after the preview is ready. Execution is queued, respects GitHub quota and is idempotent "
            "(gone or preserved items count as skipped)."
        ),
        "agent_guidance": (
            "Always run the preview first and show the user the counts. Run confirm only after the "
            "user agrees to that exact preview. Pause the bot first if the preview warns bot_active."
        ),
    },
]


def find_capability(method: str) -> "Capability | None":
    for c in CATALOG:
        if c["method"] == method:
            return c
    return None

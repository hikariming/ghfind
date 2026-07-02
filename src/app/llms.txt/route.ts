import { SITE_URL } from "@/lib/site";

export const dynamic = "force-static";
export const revalidate = 86400;

/**
 * llms.txt — declares ghfind's URL grammar so LLM agents can construct links
 * directly (mirrors the homepage Omnibox syntax). Plain text, not locale-scoped.
 */
export function GET() {
  const body = `# ghfind — GitHub developer value & trust scoring

> ghfind scores any GitHub account 0-100 for value and trustworthiness, with a
> savage one-line roast. Deterministic engine (open-sourced as the
> github-account-value skill) plus a bounded LLM adjustment.

## URL grammar (agent- and human-friendly, same as the site's Omnibox)

- Roast a user:        ${SITE_URL}/u/{username}
- Compare two users:   ${SITE_URL}/vs/{a}/{b}        (dictionary-ordered; /vs/b/a redirects to /vs/a/b)
- Language leaderboard: ${SITE_URL}/developers/language/{Language}   (e.g. /developers/language/Rust)
- Org leaderboard:     ${SITE_URL}/developers/org/{org}              (e.g. /developers/org/huggingface)
- Project leaderboard: ${SITE_URL}/developers/repo/{owner}/{name}
- Hall of Fame:        ${SITE_URL}/leaderboard

## OG images (1200x630 PNG)

- User card:   ${SITE_URL}/api/card/{username}
- Versus card: ${SITE_URL}/api/card/vs/{a}/{b}

## Programmatic API (for agents & tools)

- Machine-readable spec: ${SITE_URL}/openapi.json
- Get a score:          GET  ${SITE_URL}/api/score/{username}   (no auth, deterministic, no LLM; scores unseen accounts live on demand; 404 only if the GitHub login doesn't exist)
- Full scan payload:    POST ${SITE_URL}/api/scan  { "username": "..." }  (deterministic engine, no LLM; metrics + repo/PR signals)
- Roast report:         POST ${SITE_URL}/api/roast  (LLM; pass "byoKey" to use your own model)
- Head-to-head battle:  POST ${SITE_URL}/api/vs-verdict  { "a": "...", "b": "..." }
- Leaderboards:         GET  ${SITE_URL}/api/leaderboard?view=trending|score|heat|progress&window=all|24h|7d|30d
- Developer discovery:  GET  ${SITE_URL}/api/developers?type=language|org|repo&value={facet}
- Platform stats:       GET  ${SITE_URL}/api/stats

## Official SDKs

- JavaScript / TypeScript (npm):  ghfind   —  npm install ghfind
- Python (PyPI):                  ghfind   —  pip install ghfind

Both wrap the endpoints above as atomic methods (getScore, scan, roast, vs,
leaderboard, developers, searchUsers, stats). Scoring is deterministic and never
calls an LLM; roast/vs prose is the only LLM part and supports bring-your-own key.

## Official CLI

- Command name: ghfind
- Version: ghfind --version
- Update check: ghfind update check -o json
- Self-update: ghfind update install --method binary [--dry-run] -o json
- Package upgrades: ghfind update npm|pip|brew [--dry-run] -o json
- Command catalog: ghfind commands --json
- Factual scoring: ghfind scan {username} -o json / ghfind score {username} -o json
- Web-facing report: ghfind roast {username} --lang zh|en -o json|markdown
- Catalog APIs: ghfind stats -o json; ghfind leaderboard --view trending|score|heat|progress --window all|24h|7d|30d -o json; ghfind developers --type language|org|repo [--value {facet}] -o json

Use scan/score for individual factual scoring. Use leaderboard/developers/stats
as discovery or platform context, not as fresh per-user scoring evidence.

## Notes

- Usernames are GitHub logins (case-insensitive).
- Scores below 60 are reachable and shareable but not indexed.
- The deterministic scoring engine is open-sourced as the github-account-value skill.
`;
  return new Response(body, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, max-age=0, s-maxage=86400",
    },
  });
}

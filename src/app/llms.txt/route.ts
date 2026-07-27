import { SITE_URL } from "@/lib/site";
import {
  PRODUCT_DESCRIPTION,
  USE_CASES,
  WHEN_TO_USE,
  urlGrammarMd,
  apiSummaryMd,
  mcpSummaryMd,
  toolingMd,
  NAMED_STATS,
  AGENT_LINK_HEADER,
} from "@/lib/agent-docs";

export const dynamic = "force-static";
export const revalidate = 86400;

/**
 * llms.txt — a markdown navigation index for LLM agents. Follows the llms.txt
 * convention: an H1, a blockquote summary, then linked sections. Content shared
 * with /index.md, /auth.md, and /llms-full.txt via src/lib/agent-docs.ts.
 * Plain text (served as text/plain per the spec), not locale-scoped.
 */
export function buildLlmsTxt(): string {
  return `# ghfind — GitHub developer value & trust scoring

> ${PRODUCT_DESCRIPTION}

## What is ghfind

ghfind rates any GitHub account 0-100 across ${NAMED_STATS.dimensions} weighted dimensions with a fully
deterministic engine (no LLM in the scoring core; the same inputs always produce
the same score). In a public dataset of ${NAMED_STATS.accountsScored} scored accounts, faked or farmed
contribution was ${NAMED_STATS.flaggedShare} of accounts — rare, but extreme when present.

## Use cases

${USE_CASES.map((u) => `- ${u}`).join("\n")}

## When to use ghfind

${WHEN_TO_USE.map((w) => `- ${w}`).join("\n")}

${urlGrammarMd()}

## OG images (1200x630 PNG)

- User card: ${SITE_URL}/api/card/{username}
- Versus card: ${SITE_URL}/api/card/vs/{a}/{b}

## Embeddable cards (SVG, for a README or personal site)

- Mini card: ${SITE_URL}/api/card/mini/{username}?variant=bars|radar|strip&theme=auto|dark|light&lang=en|zh
- Score badge: ${SITE_URL}/api/badge/{username}?lang=en|zh

${apiSummaryMd()}

${mcpSummaryMd()}

${toolingMd()}

## Docs (markdown)

- Agent homepage: [${SITE_URL}/index.md](${SITE_URL}/index.md)
- API documentation (HTML): [${SITE_URL}/docs](${SITE_URL}/docs)
- Authentication: [${SITE_URL}/auth.md](${SITE_URL}/auth.md)
- Full dump (everything in one file): [${SITE_URL}/llms-full.txt](${SITE_URL}/llms-full.txt)
- Methodology: [${SITE_URL}/methodology](${SITE_URL}/methodology)
- Research / data: [${SITE_URL}/blog](${SITE_URL}/blog) (append \`.md\` to any post URL for raw markdown)

## Notes

- Usernames are GitHub logins (case-insensitive).
- Scores below 60 are reachable and shareable but not indexed.
- The deterministic scoring engine is open-sourced as the github-account-value skill.
`;
}

export function GET() {
  return new Response(buildLlmsTxt(), {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, max-age=0, s-maxage=86400",
      Link: AGENT_LINK_HEADER,
    },
  });
}

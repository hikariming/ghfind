import { createMcpHandler } from "mcp-handler";
import { z } from "zod";
import { checkMcpRateLimit } from "@/lib/redis";
import {
  scoreUser,
  scanUser,
  compareUsers,
  getLeaderboard,
  searchUsers,
} from "@/lib/mcp-tools";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * Public MCP server (Streamable HTTP) at /mcp. Served as a static top-level route
 * — mcp-handler matches on the request pathname, so it must live at the URL it
 * advertises (a next.config rewrite would leave the handler seeing the original
 * path and 404). `/mcp` has no dot but is excluded from the locale middleware
 * matcher, so next-intl never rewrites it to /zh/mcp.
 *
 * Read-only, unauthenticated, per-IP rate limited (tighter than the web limiter),
 * and every tool routes through the same caches the REST endpoints use.
 */

/** Minimal shape of the tool-callback `extra` we read (request headers for IP). */
type Extra = {
  requestInfo?: { headers?: Record<string, string | string[] | undefined> };
};

function ipFrom(extra: Extra): string {
  const h = extra.requestInfo?.headers ?? {};
  const raw = h["x-forwarded-for"] ?? h["X-Forwarded-For"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value?.split(",")[0]?.trim() || "0.0.0.0";
}

function jsonResult(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function errorResult(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

/** Per-IP throttle shared by every tool; returns an error result when tripped. */
async function guarded(
  extra: Extra,
  run: () => Promise<unknown>,
): Promise<ReturnType<typeof jsonResult>> {
  const limit = await checkMcpRateLimit(ipFrom(extra));
  if (!limit.success) {
    if (limit.unavailable) {
      return errorResult(
        `rate_limit_unavailable: request protection is temporarily unavailable; retry in ${limit.retryAfter ?? 15} seconds`,
      );
    }
    return errorResult("rate_limited: too many requests, slow down and retry in a minute");
  }
  return jsonResult(await run());
}

// Every tool is read-only and idempotent; the split is whether it can reach out
// to GitHub live (open world) or only touches our own cache/DB (closed world).
const LIVE_READONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

const CACHED_READONLY = {
  ...LIVE_READONLY,
  openWorldHint: false,
} as const;

const handler = createMcpHandler(
  (server) => {
    server.registerTool(
      "score_user",
      {
        title: "Score a GitHub account",
        description:
          "Deterministic 0-100 value & trust score, tier, and six-dimension breakdown for any GitHub login. No LLM, no auth. Scores unseen accounts live on demand.",
        inputSchema: { username: z.string().describe("GitHub login (case-insensitive)") },
        annotations: LIVE_READONLY,
      },
      (args, extra) => guarded(extra, () => scoreUser(args.username, { durablePrincipal: `mcp:${ipFrom(extra)}` })),
    );

    server.registerTool(
      "scan_user",
      {
        title: "Full scan payload",
        description:
          "Crawl a GitHub account and return the full deterministic scan: raw metrics, top repos, recent PRs, red flags, and sub-scores.",
        inputSchema: { username: z.string().describe("GitHub login") },
        annotations: LIVE_READONLY,
      },
      (args, extra) => guarded(extra, () => scanUser(args.username, { durablePrincipal: `mcp:${ipFrom(extra)}` })),
    );

    server.registerTool(
      "compare_users",
      {
        title: "Compare two developers",
        description:
          "Head-to-head deterministic comparison of two GitHub accounts, with the winner and score gap. No LLM.",
        inputSchema: {
          a: z.string().describe("First GitHub login"),
          b: z.string().describe("Second GitHub login"),
        },
        annotations: LIVE_READONLY,
      },
      (args, extra) => guarded(extra, () => compareUsers(args.a, args.b, { durablePrincipal: `mcp:${ipFrom(extra)}` })),
    );

    server.registerTool(
      "get_leaderboard",
      {
        title: "Developer leaderboard",
        description:
          "Ranked public developers. Use for discovery, not as fresh per-user scoring evidence.",
        inputSchema: {
          view: z
            .enum(["trending", "score", "heat", "progress"])
            .default("trending")
            .describe("Ranking view"),
          window: z
            .enum(["all", "24h", "7d", "30d"])
            .default("all")
            .describe("Time window"),
          limit: z
            .number()
            .int()
            .min(1)
            .max(100)
            .default(50)
            .describe("Max entries to return (default 50)"),
        },
        annotations: CACHED_READONLY,
      },
      (args, extra) => guarded(extra, () => getLeaderboard(args.view, args.window, args.limit)),
    );

    server.registerTool(
      "search_users",
      {
        title: "Search scored developers",
        description: "Prefix search across already-scored GitHub accounts (up to 6 matches).",
        inputSchema: { q: z.string().describe("Username prefix") },
        annotations: CACHED_READONLY,
      },
      (args, extra) => guarded(extra, () => searchUsers(args.q)),
    );
  },
  {
    serverInfo: { name: "ghfind", version: "1.0.0" },
    instructions:
      "ghfind scores any GitHub account 0-100 for real contribution value and trustworthiness " +
      "with a deterministic engine — no LLM touches the number, same inputs always give the same score. " +
      "Use score_user for one account's score/tier, scan_user for the full evidence payload " +
      "(metrics, repos, PRs, red flags), compare_users for a head-to-head verdict, and " +
      "get_leaderboard / search_users for discovery only — they are ranked snapshots, not fresh " +
      "per-user evidence. All tools are read-only and rate limited per IP. Do not treat a low " +
      "score as a factual claim about a person: scores use public signals only, so private-org " +
      "work is invisible to them.",
  },
  {
    // Route lives at /mcp — mcp-handler's default streamable endpoint, so no
    // basePath/rewrite needed. SSE disabled (no Redis pub/sub dependency).
    disableSse: true,
    maxDuration: 60,
  },
);

export { handler as GET, handler as POST };

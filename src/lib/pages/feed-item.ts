import { getPost } from "@/lib/blog";
import { getCollection, getCollectionArticle } from "@/lib/collections";
import type { CommentAuthor } from "@/lib/comments";
import { getBlogComments, getCollectionComments, getProfileComments, getProfileReactionState } from "@/lib/db";
import { DIMENSIONS } from "@/lib/dimensions";
import { getGoProfilePresentation } from "@/lib/go-profile.server";
import { getJob } from "@/lib/jobs";
import { normLang } from "@/lib/lang";
import { SUBSCORE_MAX } from "@/lib/score-presentation";
import {
  markdownHeadings,
  markdownParagraphs,
  type StreamComment,
  type StreamDeveloperDetail,
  type StreamItemDetail,
} from "@/lib/stream/detail";
import type { StreamCommentTarget } from "@/lib/stream/types";
import { TIER_KEY } from "@/lib/tier";

/**
 * GET /feed/item?id=<kind>:<key> — detail the stream list does not carry.
 * Every read is best-effort: a failed source just leaves its section out.
 */

const COMMENT_LIMIT = 20;

function toComment(input: { id: string; author: CommentAuthor; text: string; createdAt: number }): StreamComment {
  return {
    id: input.id,
    author:
      input.author.type === "github"
        ? { name: input.author.username, avatarUrl: input.author.avatarUrl ?? `https://github.com/${input.author.username}.png?size=64`, anonymous: false }
        : { name: "", avatarUrl: null, anonymous: true },
    text: input.text,
    createdAt: input.createdAt,
  };
}

async function quiet<T>(run: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await run();
  } catch (error) {
    console.error("feed.item_failed", error);
    return fallback;
  }
}

async function developerDetail(username: string, locale: string): Promise<StreamDeveloperDetail | null> {
  const lang = normLang(locale) === "en" ? "en" : "zh";
  const [presentation, reactions] = await Promise.all([
    quiet(() => getGoProfilePresentation(username), null),
    quiet(() => getProfileReactionState(username), null),
  ]);
  if (!presentation) return null;
  const { detail, snapshot, percentile, delta, battles, similar } = presentation;
  const metrics = snapshot?.metrics;
  const facts: StreamDeveloperDetail["facts"] = metrics
    ? [
        { key: "followers" as const, value: metrics.followers },
        { key: "totalStars" as const, value: metrics.total_stars },
        { key: "mergedPrs" as const, value: metrics.merged_pr_count },
        { key: "contributions" as const, value: metrics.last_year_contributions },
        { key: "years" as const, value: Math.round(metrics.account_age_years) },
      ].filter((fact) => fact.value > 0)
    : [];
  const roastLine = detail.roast_line?.[lang] || detail.roast_line?.zh || null;
  return {
      kind: "developer",
      roast: roastLine,
      meters: DIMENSIONS.map((key) => ({ key, value: Math.round(detail.sub_scores?.[key] ?? 0), max: SUBSCORE_MAX[key] })),
      beat: percentile?.beat ?? null,
      rank: percentile?.rank ?? null,
      total: percentile?.total ?? null,
      delta,
      bio: snapshot?.bio ?? null,
      company: snapshot?.company ?? null,
      facts,
      topRepos: (snapshot?.top_repos ?? [])
        .slice()
        .sort((a, b) => b.stars - a.stars)
        .slice(0, 4)
        .map((repo) => ({ name: repo.name_with_owner ?? repo.name, stars: repo.stars, language: repo.language, description: repo.description })),
      battles: battles.slice(0, 3).map((battle) => {
        const mine = battle.handleA.toLowerCase() === detail.username.toLowerCase();
        return {
          opponent: mine ? battle.handleB : battle.handleA,
          won: battle.winner ? battle.winner.toLowerCase() === detail.username.toLowerCase() : null,
          myScore: Math.round(mine ? battle.scoreA : battle.scoreB),
          theirScore: Math.round(mine ? battle.scoreB : battle.scoreA),
          verdict: battle.verdict?.[lang] || null,
          views: battle.viewCount,
        };
      }),
      similar: similar.slice(0, 4).map((entry) => ({
        username: entry.username,
        name: entry.display_name || entry.username,
        avatarUrl: entry.avatar_url,
        score: Math.round(entry.final_score),
        tier: TIER_KEY[entry.tier] ?? "npc",
      })),
      reactions: reactions?.counts ?? { like: 0, poop: 0, kick: 0, fire: 0, salute: 0, clown: 0 },
  };
}

async function threadComments(thread: StreamCommentTarget | null): Promise<StreamComment[]> {
  if (!thread) return [];
  const read = async (): Promise<StreamComment[]> => {
    if (thread.kind === "blog") return (await getBlogComments(thread.key, COMMENT_LIMIT)).map(toComment);
    if (thread.kind === "collection") return (await getCollectionComments(thread.key, COMMENT_LIMIT)).map(toComment);
    return (await getProfileComments(thread.key, COMMENT_LIMIT)).map(toComment);
  };
  return quiet(read, []);
}

async function itemBody(kind: string, key: string, locale: string): Promise<StreamItemDetail["body"]> {
  switch (kind) {
    case "developer":
      return developerDetail(key, locale);
    case "article": {
      const post = getPost(key, locale);
      return post ? { kind: "article", toc: markdownHeadings(post.body), excerpt: markdownParagraphs(post.body) } : null;
    }
    case "collection": {
      const collection = await quiet(() => getCollection(key), null);
      const article = collection ? await quiet(() => getCollectionArticle(collection, locale), null) : null;
      return article ? { kind: "collection", excerpt: markdownParagraphs(article.body, 3, 600) } : null;
    }
    case "job": {
      const job = await quiet(() => getJob(locale, key), null);
      return job ? { kind: "job", description: markdownParagraphs(job.description, 6, 1_200), website: job.company.websiteUrl } : null;
    }
    default:
      return null;
  }
}

/** `thread` is the item's comment target ("profile:login"), validated here. */
export function parseThread(value: string | null): StreamCommentTarget | null {
  const match = value?.match(/^(blog|collection|profile):([A-Za-z0-9._-]{1,100})$/);
  return match ? { kind: match[1] as StreamCommentTarget["kind"], key: match[2] } : null;
}

export async function loadFeedItemDetail(id: string, locale: string, thread: StreamCommentTarget | null): Promise<StreamItemDetail | null> {
  const separator = id.indexOf(":");
  if (separator < 0) return null;
  const kind = id.slice(0, separator);
  const key = id.slice(separator + 1);
  if (!key || key.startsWith("demo:")) return { id, body: null, comments: [] };
  const [body, comments] = await Promise.all([itemBody(kind, key, locale), threadComments(thread)]);
  return { id, body, comments };
}

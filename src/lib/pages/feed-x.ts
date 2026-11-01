import { EDITORIAL_X_ACCOUNTS } from "@/config/x-accounts";
import { translationFor, xHeat, type XAccount, type XPost, type XTimeline } from "@/lib/stream/x";
import type { StreamItem, StreamVoice } from "@/lib/stream/types";

/**
 * X timeline → stream items. Kept apart from feed.ts so the linking rules are
 * testable: a post's author id is the linked GitHub login when there is one,
 * which is also the id of that person's developer/talent items, so follows,
 * "more from" and the comment thread are shared across both.
 */

const CATEGORY_PRIOR: Record<string, number> = { researcher: 0.9, builder: 0.85, media: 0.7, developer: 0.8 };
const NOTE = new Map(EDITORIAL_X_ACCOUNTS.map((entry) => [entry.handle.toLowerCase(), entry.note]));

export function authorIdFor(account: Pick<XAccount, "github" | "handle">): string {
  return account.github ? account.github.toLowerCase() : `x:${account.handle}`;
}

function title(text: string): string {
  const line = text.split("\n").find((part) => part.trim()) ?? text;
  return line.length > 90 ? `${line.slice(0, 88).trimEnd()}…` : line;
}

export function xStreamItems(timeline: XTimeline, locale: string): StreamItem[] {
  const lang = locale === "zh" ? "zh" : "en";
  const accounts = new Map(timeline.accounts.map((account) => [account.handle, account]));
  return timeline.posts.flatMap((post: XPost): StreamItem[] => {
    const account = accounts.get(post.handle);
    if (!account) return [];
    const prior = account.ghfind ? account.ghfind.score / 100 : CATEGORY_PRIOR[account.category] ?? 0.7;
    const note = NOTE.get(account.handle);
    return [{
      id: `post:${post.id}`,
      kind: "post",
      title: title(post.text),
      summary: post.text,
      body: null,
      author: {
        id: authorIdFor(account),
        name: account.name,
        avatarUrl: account.avatarUrl ?? (account.github ? `https://github.com/${account.github}.png?size=80` : null),
        handle: `@${account.handle}`,
        x: { handle: account.handle, verified: account.verified, category: account.category },
      },
      coverUrl: null,
      tags: post.topics.slice(0, 4),
      score: account.ghfind?.score ?? null,
      scoreLabel: account.ghfind?.tier ?? null,
      stats: note ? [{ label: "note", value: note[lang] }] : [],
      href: post.url,
      external: true,
      publishedAt: post.createdAt,
      readingMinutes: null,
      sponsored: false,
      quality: Math.min(1, 0.6 * post.technical + 0.4 * prior),
      heat: xHeat(post),
      counter: null,
      badge: null,
      comments: account.github ? { kind: "profile", key: account.github } : null,
      extra: {
        kind: "post",
        handle: account.handle,
        verified: account.verified,
        category: account.category,
        metrics: post.metrics,
        media: post.media,
        quote: post.quote,
        github: account.github,
        // Older stored posts predate translations.
        translation: translationFor({ lang: post.lang, translations: post.translations ?? {} }, locale),
      },
    }];
  });
}

/** Curated voices that actually have posts in the window, busiest first. */
export function xVoices(timeline: XTimeline): StreamVoice[] {
  const counts = new Map<string, number>();
  for (const post of timeline.posts) counts.set(post.handle, (counts.get(post.handle) ?? 0) + 1);
  return timeline.accounts
    .filter((account) => counts.has(account.handle))
    .map((account) => ({
      handle: account.handle,
      name: account.name,
      avatarUrl: account.avatarUrl ?? (account.github ? `https://github.com/${account.github}.png?size=80` : null),
      category: account.category,
      verified: account.verified,
      github: account.github,
      posts: counts.get(account.handle) ?? 0,
    }))
    .sort((a, b) => b.posts - a.posts)
    .slice(0, 8);
}

/** Puts the linked X account on developer/talent items of the same person. */
export function linkXAccounts(items: StreamItem[], timeline: XTimeline): StreamItem[] {
  const byGithub = new Map<string, XAccount>();
  const byTalent = new Map<string, XAccount>();
  for (const account of timeline.accounts) {
    if (account.github) byGithub.set(account.github.toLowerCase(), account);
    if (account.talentId) byTalent.set(account.talentId, account);
  }
  return items.map((item) => {
    if (item.kind !== "developer" && item.kind !== "talent") return item;
    const account = byGithub.get(item.author.id.toLowerCase()) ?? (item.kind === "talent" ? byTalent.get(item.id.slice("talent:".length)) : undefined);
    if (!account) return item;
    return { ...item, author: { ...item.author, x: { handle: account.handle, verified: account.verified, category: account.category } } };
  });
}

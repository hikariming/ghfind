import { getCollectionArticle, getGitHubNickname, listCollections, pickText } from "@/lib/collections";

/**
 * Homepage data shared by the Next page and apps/web. Collection cards are
 * resolved to plain, localized values here, so the client card band never
 * imports the content library (src/lib/collections embeds every article).
 */
export async function loadHomeCollectionCards(locale: string) {
  const collections = listCollections().slice(0, 8);
  return Promise.all(
    collections.map(async (collection, index) => {
      const githubUsername =
        collection.subject?.kind === "developer" ? collection.subject.id : null;
      const identityName =
        collection.subject?.nickname ??
        (githubUsername ? await getGitHubNickname(githubUsername) : null);
      const article =
        collection.bodyLocales.length > 0
          ? getCollectionArticle(collection.slug, locale)
          : null;
      const avatarOwner = collection.subject
        ? collection.subject.kind === "repo"
          ? collection.subject.id.split("/")[0]
          : collection.subject.id
        : null;
      const title = pickText(collection.title, locale);
      const titleParts = title.match(/^([^:：]+)\s*[:：]\s*(.+)$/);
      const displayName =
        identityName ?? (!collection.subject ? titleParts?.[1] : null);
      return {
        slug: collection.slug,
        position: index + 1,
        title: displayName ? (titleParts?.[2] ?? title) : title,
        intro: pickText(collection.intro, locale),
        type: collection.type,
        githubUsername,
        identityName: displayName ?? undefined,
        avatarUrl: avatarOwner ? `https://github.com/${avatarOwner}.png?size=112` : null,
        publishedAt: collection.publishedAt,
        readingMinutes: article?.readingMinutes ?? null,
      };
    }),
  );
}

export type HomeCollectionCard = Awaited<ReturnType<typeof loadHomeCollectionCards>>[number];

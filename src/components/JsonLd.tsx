import { SITE_URL } from "@/lib/site";

/**
 * Renders a JSON-LD `<script>`. Server component — the structured data is in the
 * initial HTML so crawlers see it without executing JS.
 *
 * Builders below keep the schema shapes in one place. Lead with deterministic,
 * structured fields (name, score, url) — never the volatile roast text — so the
 * markup stays stable and trustworthy across re-scans and model changes.
 */
export function JsonLd({ data }: { data: Record<string, unknown> }) {
  return (
    <script
      type="application/ld+json"
      // Schema is built from our own typed data, not user free-text HTML.
      dangerouslySetInnerHTML={{ __html: JSON.stringify(data) }}
    />
  );
}

/** Site-wide identity + a SearchAction so Google can offer a username lookup box. */
export function websiteJsonLd(opts: { name: string; description: string }) {
  return {
    "@context": "https://schema.org",
    "@type": "WebSite",
    name: opts.name,
    description: opts.description,
    url: `${SITE_URL}/`,
    inLanguage: ["zh-CN", "en"],
    potentialAction: {
      "@type": "SearchAction",
      target: {
        "@type": "EntryPoint",
        urlTemplate: `${SITE_URL}/u/{search_term_string}`,
      },
      "query-input": "required name=search_term_string",
    },
    publisher: {
      "@type": "Organization",
      name: opts.name,
      url: `${SITE_URL}/`,
    },
  };
}

function uPath(username: string, locale: string): string {
  return locale === "en" ? `/en/u/${username}` : `/u/${username}`;
}

/** A `Person` node for a scored developer — the directory's core entity. */
function personNode(opts: {
  username: string;
  displayName: string | null;
  avatarUrl: string | null;
  profileUrl: string | null;
  locale: string;
}) {
  return {
    "@type": "Person",
    name: opts.displayName || opts.username,
    alternateName: opts.username,
    url: `${SITE_URL}${uPath(opts.username, opts.locale)}`,
    jobTitle: "Software Developer",
    ...(opts.avatarUrl ? { image: opts.avatarUrl } : {}),
    // Link out to the canonical GitHub profile as the same-as identity.
    ...(opts.profileUrl ? { sameAs: [opts.profileUrl] } : {}),
  };
}

/** A scored developer's profile page (Person inside a ProfilePage). */
export function profileJsonLd(opts: {
  username: string;
  displayName: string | null;
  avatarUrl: string | null;
  profileUrl: string | null;
  score: number;
  locale: string;
  /** Epoch ms of the last score — emitted as `dateModified` for crawl freshness. */
  scannedAt?: number | null;
}) {
  const url = `${SITE_URL}${uPath(opts.username, opts.locale)}`;
  return {
    "@context": "https://schema.org",
    "@type": "ProfilePage",
    url,
    ...(opts.scannedAt
      ? { dateModified: new Date(opts.scannedAt).toISOString() }
      : {}),
    mainEntity: personNode(opts),
  };
}

/** A research/blog article. `date`/`updated` are ISO dates from the post frontmatter. */
export function articleJsonLd(opts: {
  slug: string;
  locale: string;
  title: string;
  description: string;
  date: string;
  updated?: string;
  tags: string[];
}) {
  const path = opts.locale === "en" ? `/en/blog/${opts.slug}` : `/blog/${opts.slug}`;
  return {
    "@context": "https://schema.org",
    "@type": "Article",
    headline: opts.title,
    description: opts.description,
    datePublished: opts.date,
    ...(opts.updated ? { dateModified: opts.updated } : {}),
    inLanguage: opts.locale === "en" ? "en" : "zh-CN",
    ...(opts.tags.length ? { keywords: opts.tags.join(", ") } : {}),
    image: [`${SITE_URL}/api/og/blog/${opts.slug}`],
    mainEntityOfPage: { "@type": "WebPage", "@id": `${SITE_URL}${path}` },
    author: { "@type": "Organization", name: "ghfind", url: `${SITE_URL}/` },
    publisher: { "@type": "Organization", name: "ghfind", url: `${SITE_URL}/` },
  };
}

/** The leaderboard as a ranked developer directory (CollectionPage + ItemList). */
export function leaderboardJsonLd(opts: {
  name: string;
  description: string;
  locale: string;
  entries: Array<{
    username: string;
    display_name: string | null;
    avatar_url: string | null;
    profile_url: string | null;
  }>;
}) {
  const path = opts.locale === "en" ? "/en/leaderboard" : "/leaderboard";
  return {
    "@context": "https://schema.org",
    "@type": "CollectionPage",
    url: `${SITE_URL}${path}`,
    name: opts.name,
    description: opts.description,
    mainEntity: {
      "@type": "ItemList",
      itemListOrder: "https://schema.org/ItemListOrderDescending",
      numberOfItems: opts.entries.length,
      itemListElement: opts.entries.map((e, i) => ({
        "@type": "ListItem",
        position: i + 1,
        item: personNode({
          username: e.username,
          displayName: e.display_name,
          avatarUrl: e.avatar_url,
          profileUrl: e.profile_url,
          locale: opts.locale,
        }),
      })),
    },
  };
}

import { SITE_URL, bcp47, localePath } from "@/lib/site";

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

/**
 * Third-party identifiers that let AI disambiguate the ghfind brand from
 * similarly-named entities. Add the Wikidata entity URL here once it exists
 * (see planning/agent-readiness-orank.md) to complete the entity-linking loop.
 */
export const GHFIND_SAME_AS = [
  "https://github.com/hikariming/ghfind",
  "https://www.npmjs.com/package/@hikariming/ghfind",
  "https://pypi.org/project/ghfind/",
];

/** The Organization node, reused as publisher/creator across schemas. */
export function organizationNode(name = "ghfind") {
  return {
    "@type": "Organization",
    "@id": `${SITE_URL}/#organization`,
    name,
    url: `${SITE_URL}/`,
    logo: `${SITE_URL}/icon.svg`,
    sameAs: GHFIND_SAME_AS,
    contactPoint: {
      "@type": "ContactPoint",
      contactType: "customer support",
      url: `${SITE_URL}/contact`,
    },
  };
}

/** Standalone Organization JSON-LD (business-legitimacy signals for agents). */
export function organizationJsonLd(name = "ghfind") {
  return { "@context": "https://schema.org", ...organizationNode(name) };
}

/** WebApplication identity so agents can parse ghfind as a product/tool. */
export function softwareApplicationJsonLd(opts: { name: string; description: string }) {
  return {
    "@context": "https://schema.org",
    "@type": "WebApplication",
    "@id": `${SITE_URL}/#software`,
    name: opts.name,
    description: opts.description,
    url: `${SITE_URL}/`,
    applicationCategory: "DeveloperApplication",
    operatingSystem: "Web",
    inLanguage: ["zh-CN", "en"],
    offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
    featureList: [
      "Deterministic 0-100 GitHub value & trust score",
      "Six-dimension score breakdown",
      "Bot / farmed-contribution detection",
      "Developer head-to-head battles",
      "Leaderboards by language, org, and project",
      "Public REST API, npm/PyPI SDKs, CLI, and MCP server",
    ],
    softwareHelp: `${SITE_URL}/llms.txt`,
    isAccessibleForFree: true,
    publisher: organizationNode(opts.name),
  };
}

/** FAQPage from the same Q&A array the homepage renders. */
export function faqJsonLd(items: Array<{ q: string; a: string }>) {
  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: items.map((item) => ({
      "@type": "Question",
      name: item.q,
      acceptedAnswer: { "@type": "Answer", text: item.a },
    })),
  };
}

/** BreadcrumbList for nested directory / profile pages. */
export function breadcrumbJsonLd(items: Array<{ name: string; path: string }>) {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: items.map((item, i) => ({
      "@type": "ListItem",
      position: i + 1,
      name: item.name,
      item: `${SITE_URL}${item.path}`,
    })),
  };
}

/** Site-wide identity + a SearchAction so Google can offer a username lookup box. */
export function websiteJsonLd(opts: { name: string; description: string }) {
  return {
    "@context": "https://schema.org",
    "@type": "WebSite",
    "@id": `${SITE_URL}/#website`,
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
    publisher: organizationNode(opts.name),
    // Tell AI TTS which parts are worth reading aloud.
    speakable: {
      "@type": "SpeakableSpecification",
      cssSelector: ["h1", ".home-faq"],
    },
  };
}

function uPath(username: string, locale: string): string {
  return localePath(locale, `/u/${username}`);
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
  const path = localePath(opts.locale, `/blog/${opts.slug}`);
  return {
    "@context": "https://schema.org",
    "@type": "Article",
    headline: opts.title,
    description: opts.description,
    datePublished: opts.date,
    ...(opts.updated ? { dateModified: opts.updated } : {}),
    inLanguage: bcp47(opts.locale),
    ...(opts.tags.length ? { keywords: opts.tags.join(", ") } : {}),
    image: [`${SITE_URL}/api/og/blog/${opts.slug}`],
    mainEntityOfPage: { "@type": "WebPage", "@id": `${SITE_URL}${path}` },
    // Named author (E-E-A-T) with an identity link, plus the org publisher.
    author: {
      "@type": "Person",
      name: "hikariming",
      url: "https://github.com/hikariming",
      sameAs: ["https://github.com/hikariming"],
    },
    publisher: organizationNode("ghfind"),
    speakable: { "@type": "SpeakableSpecification", cssSelector: ["h1"] },
  };
}

/**
 * Dataset JSON-LD for data-driven research posts — establishes ghfind as the
 * originating source of GitHub-account scoring data (a citable primary source).
 */
export function datasetJsonLd(opts: {
  slug: string;
  locale: string;
  name: string;
  description: string;
  date: string;
  updated?: string;
}) {
  const path = localePath(opts.locale, `/blog/${opts.slug}`);
  return {
    "@context": "https://schema.org",
    "@type": "Dataset",
    name: opts.name,
    description: opts.description,
    url: `${SITE_URL}${path}`,
    datePublished: opts.date,
    ...(opts.updated ? { dateModified: opts.updated } : {}),
    license: "https://www.gnu.org/licenses/agpl-3.0.html",
    isAccessibleForFree: true,
    creator: organizationNode("ghfind"),
    publisher: organizationNode("ghfind"),
    keywords: ["GitHub", "developer scoring", "open source", "anti-abuse"],
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
  const path = localePath(opts.locale, "/leaderboard");
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

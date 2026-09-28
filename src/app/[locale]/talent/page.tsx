import type { Metadata } from 'next';
import { setRequestLocale } from 'next-intl/server';
import { TalentDirectory, ALL as FILTER_ALL, type TalentDirectoryFilters } from '@/components/talent/TalentDirectory';
import { getTalentOverview, listTalentsPage, listTalentFacets, type TalentOverview, type TalentSort } from '@/lib/talent-db';
import { isTalentCategory } from '@/components/talent/categories';

export const metadata: Metadata = {
  title: '人才库 · ghfind',
  description: '从开源作品出发，发现值得认识的开发者。',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

const SORTS: TalentSort[] = ['recommended', 'stars', 'activity'];

// The query string is the shareable source of truth for the directory view:
// filters render server-side on the first hit, then the client takes over.
export default async function TalentPage({ params, searchParams }: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ locale }, sp] = await Promise.all([params, searchParams]);
  setRequestLocale(locale);
  const pick = (key: string) => {
    const value = sp[key];
    return (Array.isArray(value) ? value[0] : value)?.trim() || undefined;
  };
  const sort = pick('sort');
  const source = pick('source');
  const category = pick('category');
  const filters: TalentDirectoryFilters = {
    query: pick('q') ?? '',
    category: isTalentCategory(category) ? category : FILTER_ALL,
    direction: pick('direction') ?? FILTER_ALL,
    tag: pick('tag') ?? FILTER_ALL,
    project: pick('project') ?? FILTER_ALL,
    location: pick('location') ?? FILTER_ALL,
    source: source === 'github' || source === 'manual' ? source : FILTER_ALL,
    available: pick('available') === '1',
    sort: SORTS.includes(sort as TalentSort) ? (sort as TalentSort) : 'recommended',
  };
  const page = Math.max(0, (Number.parseInt(pick('page') ?? '1', 10) || 1) - 1);
  const pageSize = Number.parseInt(pick('pageSize') ?? '', 10) || undefined;
  // A bare /talent visit opens the discover tab; any filter, a page number or
  // ?view=all goes straight to the full directory grid.
  const filtered = [filters.category, filters.direction, filters.tag, filters.project, filters.location, filters.source].some(v => v !== FILTER_ALL)
    || !!filters.query || filters.available || !!pick('page');
  const initialTab = filtered || pick('view') === 'all' ? 'all' : 'discover';

  let list: Awaited<ReturnType<typeof listTalentsPage>> = { items: [], total: 0, page: 0, pageSize: 24, hasMore: false };
  let facets: Awaited<ReturnType<typeof listTalentFacets>> = { directions: [], locations: [], tags: [] };
  let overview: TalentOverview | null = null;
  try {
    [list, facets, overview] = await Promise.all([
      listTalentsPage({
        locale,
        query: filters.query || undefined,
        category: isTalentCategory(filters.category) ? filters.category : undefined,
        direction: filters.direction !== FILTER_ALL ? filters.direction : undefined,
        tag: filters.tag !== FILTER_ALL ? filters.tag : undefined,
        project: filters.project !== FILTER_ALL ? filters.project : undefined,
        location: filters.location !== FILTER_ALL ? filters.location : undefined,
        source: filters.source !== FILTER_ALL ? filters.source as 'github' | 'manual' : undefined,
        available: filters.available || undefined,
        sort: filters.sort === 'recommended' ? undefined : filters.sort as TalentSort,
        page,
        pageSize,
      }),
      listTalentFacets(),
      initialTab === 'discover' ? getTalentOverview(locale) : Promise.resolve(null),
    ]);
  } catch (error) {
    console.error('talent.load_failed', error);
  }
  return <TalentDirectory initialList={list} initialTotal={list.total} facets={facets} initialFilters={filters} initialTab={initialTab} initialOverview={overview} />;
}

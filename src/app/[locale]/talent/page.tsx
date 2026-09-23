import type { Metadata } from 'next';
import { setRequestLocale } from 'next-intl/server';
import { TalentDirectory, ALL as FILTER_ALL, type TalentDirectoryFilters } from '@/components/talent/TalentDirectory';
import { listTalentsPage, listTalentFacets, type TalentSort } from '@/lib/talent-db';

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
  const filters: TalentDirectoryFilters = {
    query: pick('q') ?? '',
    direction: pick('direction') ?? FILTER_ALL,
    location: pick('location') ?? FILTER_ALL,
    source: source === 'github' || source === 'manual' ? source : FILTER_ALL,
    available: pick('available') === '1',
    sort: SORTS.includes(sort as TalentSort) ? (sort as TalentSort) : 'recommended',
  };
  const page = Math.max(0, (Number.parseInt(pick('page') ?? '1', 10) || 1) - 1);
  const pageSize = Number.parseInt(pick('pageSize') ?? '', 10) || undefined;

  let list: Awaited<ReturnType<typeof listTalentsPage>> = { items: [], total: 0, page: 0, pageSize: 24, hasMore: false };
  let facets: Awaited<ReturnType<typeof listTalentFacets>> = { directions: [], locations: [] };
  try {
    [list, facets] = await Promise.all([
      listTalentsPage({
        locale,
        query: filters.query || undefined,
        direction: filters.direction !== FILTER_ALL ? filters.direction : undefined,
        location: filters.location !== FILTER_ALL ? filters.location : undefined,
        source: filters.source !== FILTER_ALL ? filters.source as 'github' | 'manual' : undefined,
        available: filters.available || undefined,
        sort: filters.sort === 'recommended' ? undefined : filters.sort as TalentSort,
        page,
        pageSize,
      }),
      listTalentFacets(),
    ]);
  } catch (error) {
    console.error('talent.load_failed', error);
  }
  return <TalentDirectory initialList={list} initialTotal={list.total} facets={facets} initialFilters={filters} />;
}

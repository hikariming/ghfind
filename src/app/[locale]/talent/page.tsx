import type { Metadata } from 'next';
import { setRequestLocale } from 'next-intl/server';
import { TalentDirectory } from '@/components/talent/TalentDirectory';
import { listTalentsPage, listTalentFacets } from '@/lib/talent-db';

export const metadata: Metadata = {
  title: '人才库 · ghfind',
  description: '从开源作品出发，发现值得认识的开发者。',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

export default async function TalentPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  let list: Awaited<ReturnType<typeof listTalentsPage>> = { items: [], total: 0, page: 0, pageSize: 48, hasMore: false };
  let facets: Awaited<ReturnType<typeof listTalentFacets>> = { directions: [], locations: [] };
  try {
    [list, facets] = await Promise.all([listTalentsPage({ locale }), listTalentFacets()]);
  } catch (error) {
    console.error('talent.load_failed', error);
  }
  return <TalentDirectory initialList={list} initialTotal={list.total} facets={facets} />;
}

import type { Metadata } from 'next';
import { setRequestLocale } from 'next-intl/server';
import { TalentDirectory } from '@/components/talent/TalentDirectory';
import { listPublishedTalents } from '@/lib/talent-db';
import type { Talent } from '@/components/talent/data';

export const metadata: Metadata = {
  title: '人才库 · ghfind',
  description: '从开源作品出发，发现值得认识的开发者。',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

export default async function TalentPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  let talents: Talent[] = [];
  try {
    talents = await listPublishedTalents();
  } catch (error) {
    console.error('talent.load_failed', error);
  }
  return <TalentDirectory initialTalents={talents} />;
}

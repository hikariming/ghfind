'use client';

import { useTranslations } from 'next-intl';
import { ArrowRight, Bot, Gauge, LayoutPanelTop, Layers, Server, Shapes, Sparkles, Wrench, type LucideIcon } from 'lucide-react';
import type { Talent } from './data';
import type { TalentCategoryId } from './categories';
import { TalentAvatar } from './TalentAvatar';
import styles from './talent.module.css';

export const CATEGORY_ICONS: Record<TalentCategoryId, LucideIcon> = { agent: Bot, ai: Sparkles, infra: Server, frontend: LayoutPanelTop, tools: Wrench, other: Shapes };

export type TalentOverviewGroup = { id: string; total: number; items: Talent[] };
export type TalentOverviewData = { collections: TalentOverviewGroup[]; sections: TalentOverviewGroup[] };

// Discover tab: featured collections (project ecosystems, official tags) on
// top, then a short ranked list per category. Every "view all" hands off to
// the filtered directory grid.
export function TalentOverview({ overview, onOpenTalent, onOpenCollection, onOpenCategory }: {
  overview: TalentOverviewData | null;
  onOpenTalent: (talent: Talent) => void;
  onOpenCollection: (id: string) => void;
  onOpenCategory: (id: TalentCategoryId) => void;
}) {
  const t = useTranslations('talent');
  if (!overview) return <div className={styles.overviewLoading}>{t('results.loading')}</div>;
  return <div className={styles.overview}>
    {overview.collections.length > 0 && <section>
      <header className={styles.overviewHead}><h2><Layers size={16} />{t('overview.collectionsTitle')}</h2><p>{t('overview.collectionsSubtitle')}</p></header>
      <div className={styles.collectionGrid}>
        {overview.collections.map(c => <button key={c.id} className={styles.collectionCard} onClick={() => onOpenCollection(c.id)}>
          <span className={styles.collectionTitle}><strong>{t(`collections.${c.id}.title`)}</strong><small>{t('overview.people', { count: c.total })}</small></span>
          <span className={styles.collectionDesc}>{t(`collections.${c.id}.desc`)}</span>
          <span className={styles.collectionPeople}>
            <span className={styles.avatarStack}>{c.items.map(x => <TalentAvatar key={x.id} talent={x} />)}</span>
            <span className={styles.collectionNames}>{c.items.slice(0, 3).map(x => x.name.replace(/\s*[（(].*$/, '')).join(' · ')}</span>
          </span>
        </button>)}
      </div>
    </section>}
    <section>
      <header className={styles.overviewHead}><h2><LayoutPanelTop size={16} />{t('overview.sectionsTitle')}</h2><p>{t('overview.sectionsSubtitle')}</p></header>
      <div className={styles.sectionGrid}>
        {overview.sections.map(s => {
          const id = s.id as TalentCategoryId;
          const Icon = CATEGORY_ICONS[id] ?? Shapes;
          return <article key={s.id} className={styles.sectionCard}>
            <header><span className={styles.sectionIcon}><Icon size={15} /></span><strong>{t(`categories.${id}`)}</strong><small>{t('overview.people', { count: s.total })}</small></header>
            <ol>
              {s.items.map((x, i) => <li key={x.id}><button onClick={() => onOpenTalent(x)} aria-label={t('card.viewProfileAria', { name: x.name })}>
                <span className={styles.rank}>{i + 1}</span>
                <TalentAvatar talent={x} />
                <span className={styles.sectionPerson}><strong>{x.name}</strong><small>{x.role || x.bio}</small></span>
                {typeof x.score === 'number' && x.score >= 60 && <span className={styles.sectionScore} title={t('card.score')}><Gauge size={11} />{x.score.toFixed(1)}</span>}
              </button></li>)}
            </ol>
            <button className={styles.sectionMore} onClick={() => onOpenCategory(id)}>{t('overview.viewAll', { count: s.total })} <ArrowRight size={13} /></button>
          </article>;
        })}
      </div>
    </section>
  </div>;
}

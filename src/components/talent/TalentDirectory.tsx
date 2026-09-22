'use client';

import { useEffect, useRef, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { ArrowDownUp, ArrowRight, ArrowUpRight, BadgeCheck, Bookmark, Check, CheckCheck, Code2, FolderGit2, Gauge, GitFork, Globe2, LayoutGrid, List, MapPin, Plus, Search, SlidersHorizontal, Star, Users, X } from 'lucide-react';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import type { Talent } from './data';
import { TalentAvatar } from './TalentAvatar';
import styles from './talent.module.css';
import { TalentIntake } from './TalentIntake';
import { TalentDetail } from './TalentDetail';
import { submitTalentIntake } from './actions';

const format = (n: number) => n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);

// Filter states use untranslated sentinels; DB values for `source` contain
// 'GitHub' / '人工整理' regardless of locale, so matching stays data-based.
const ALL = 'all';

export type TalentListPayload = { items: Talent[]; total: number; page: number; pageSize: number; hasMore: boolean };
export type TalentFacets = { directions: string[]; locations: string[] };

export function TalentDirectory({ initialList, initialTotal, facets }: { initialList: TalentListPayload; initialTotal: number; facets: TalentFacets }) {
  const t = useTranslations('talent');
  const locale = useLocale();
  const [items, setItems] = useState(initialList.items);
  const [total, setTotal] = useState(initialList.total);
  const [hasMore, setHasMore] = useState(initialList.hasMore);
  const [pageSize, setPageSize] = useState(initialList.pageSize);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [direction, setDirection] = useState(ALL);
  const [saved, setSaved] = useState<string[]>([]);
  const [savedItems, setSavedItems] = useState<Talent[] | null>(null);
  const [tab, setTab] = useState('all');
  const [filters, setFilters] = useState(false);
  const [location, setLocation] = useState(ALL);
  const [source, setSource] = useState(ALL);
  const [available, setAvailable] = useState(false);
  const [sort, setSort] = useState('recommended');
  const [view, setView] = useState('grid');
  const [selected, setSelected] = useState<Talent | null>(null);
  const [adding, setAdding] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [notice, setNotice] = useState('');
  const requestSeq = useRef(0);
  const toggleSaved = (id: string) => setSaved(prev => prev.includes(id) ? prev.filter(value => value !== id) : [...prev, id]);
  const reset = () => { setQuery(''); setDirection(ALL); setLocation(ALL); setSource(ALL); setAvailable(false); };

  useEffect(() => { const timer = setTimeout(() => setDebouncedQuery(query.trim()), 300); return () => clearTimeout(timer); }, [query]);

  const buildUrl = (page: number) => {
    const params = new URLSearchParams({ locale, page: String(page), sort });
    if (debouncedQuery) params.set('q', debouncedQuery);
    if (direction !== ALL) params.set('direction', direction);
    if (location !== ALL) params.set('location', location);
    if (source !== ALL) params.set('source', source);
    if (available) params.set('available', '1');
    return `/api/talent?${params.toString()}`;
  };

  // Reload from page 0 whenever the server-side filter set changes. The
  // initial server-rendered page covers the first paint, so skip mount.
  const filterKey = JSON.stringify([debouncedQuery, direction, location, source, available, sort, locale]);
  const mounted = useRef(false);
  useEffect(() => {
    if (!mounted.current) { mounted.current = true; return; }
    const seq = ++requestSeq.current;
    setLoading(true);
    fetch(buildUrl(0)).then(r => r.json()).then((data: TalentListPayload) => {
      if (seq !== requestSeq.current) return;
      setItems(data.items); setTotal(data.total); setHasMore(data.hasMore); setPageSize(data.pageSize); setLoading(false);
    }).catch(() => { if (seq === requestSeq.current) setLoading(false); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterKey]);

  const loadMore = () => {
    const seq = ++requestSeq.current;
    setLoading(true);
    fetch(buildUrl(Math.ceil(items.length / pageSize))).then(r => r.json()).then((data: TalentListPayload) => {
      if (seq !== requestSeq.current) return;
      setItems(prev => [...prev, ...data.items.filter(x => !prev.some(y => y.id === x.id))]);
      setTotal(data.total); setHasMore(data.hasMore); setLoading(false);
    }).catch(() => { if (seq === requestSeq.current) setLoading(false); });
  };

  // The saved list lives client-side; resolve the bookmarks via id lookup.
  useEffect(() => {
    if (tab !== 'saved') return;
    let cancelled = false;
    const load: Promise<Talent[]> = saved.length
      ? fetch(`/api/talent?locale=${locale}&ids=${saved.join(',')}`).then(r => r.json()).then((data: TalentListPayload) => data.items).catch(() => [])
      : Promise.resolve([]);
    load.then(list => { if (!cancelled) setSavedItems(list); });
    return () => { cancelled = true; };
  }, [tab, saved, locale]);

  // Cards render from light list rows; the modal pulls the full record
  // (projects, sources, note, contacts) on demand.
  const openTalent = (talent: Talent) => {
    setSelected(talent);
    fetch(`/api/talent/${encodeURIComponent(talent.id)}?locale=${locale}`).then(r => r.ok ? r.json() : null).then((full: Talent | null) => {
      if (!full) return;
      setSelected(prev => prev?.id === full.id ? full : prev);
      setItems(prev => prev.map(x => x.id === full.id ? { ...x, ...full } : x));
    }).catch(() => {});
  };

  async function addTalent(talent: Talent) {
    setSubmitting(true);
    const result = await submitTalentIntake(talent);
    setSubmitting(false);
    if (!result.ok) { setNotice(result.message); return; }
    setAdding(false); reset(); setTab('all'); setSort('recommended');
    setNotice(t('notice.submitted', { name: talent.name }));
  }

  const results = tab === 'saved' ? (savedItems ?? []) : items;
  const activeFilters = Number(location !== ALL) + Number(source !== ALL) + Number(available);

  return <main className={styles.page}>
    <div className={styles.topline}><span>{t('topline.section')} <span className={styles.slash}>/</span> <strong>{t('topline.current')}</strong></span><span className={styles.preview}><span /> {t('topline.badge')}</span></div>
    <section className={styles.hero}>
      <h1>{t('hero.titleLead')}<br />{t('hero.titleVerb')}<span>{t('hero.titleAccent')}</span><span className={styles.heroAsterisk}>✳</span></h1>
      <p>{t('hero.subtitleLead')}<br className={styles.desktopBreak} /> {t('hero.subtitleTail')}</p>
      <div className={styles.heroBottom}><div className={styles.people}><div className={styles.miniAvatars}>{initialList.items.slice(0, 4).map(x => <TalentAvatar key={x.id} talent={x} />)}</div><span>{t('hero.people')}</span></div><button className={styles.primary} onClick={() => setAdding(true)}><Plus size={16} /> {t('hero.add')}</button></div>
      <div className={styles.heroCode} aria-hidden="true"><Code2 size={32} /><span>{t('hero.code')}</span><div><i /><i /><i /><i /><i /><i /><i /><i /><i /><i /><i /><i /><i /><i /><i /><i /><i /><i /></div></div>
    </section>

    <section className={styles.directory} aria-label={t('tabs.aria')}>
      <div className={styles.tabs}><div><button data-active={tab === 'all'} onClick={() => setTab('all')}><Users size={16} /> {t('tabs.all')} <span>{initialTotal}</span></button><button data-active={tab === 'saved'} onClick={() => setTab('saved')}><Bookmark size={16} /> {t('tabs.saved')} <span>{saved.length}</span></button></div><span className={styles.sessionHint}>{t('tabs.sessionHint')}</span></div>
      <div className={styles.searchRow}><label className={styles.search}><Search size={19} /><input value={query} onChange={e => setQuery(e.target.value)} placeholder={t('search.placeholder')} aria-label={t('search.aria')} />{query && <button aria-label={t('search.clear')} onClick={() => setQuery('')}><X size={15} /></button>}</label><button className={styles.secondary} data-active={filters} onClick={() => setFilters(!filters)} aria-expanded={filters}><SlidersHorizontal size={16} /> {t('filters.toggle')} {activeFilters > 0 && <span>{activeFilters}</span>}</button></div>
      {filters && <div className={styles.filters}><label>{t('filters.location')}<select value={location} onChange={e => setLocation(e.target.value)}>{[ALL, ...facets.locations].map(s => <option key={s} value={s}>{s === ALL ? t('filters.allLocations') : s}</option>)}</select></label><label>{t('filters.source')}<select value={source} onChange={e => setSource(e.target.value)}>{[[ALL, t('filters.allSources')], ['github', t('filters.sourceGithub')], ['manual', t('filters.sourceManual')]].map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label className={styles.checkbox}><input type="checkbox" checked={available} onChange={e => setAvailable(e.target.checked)} /> {t('filters.onlyAvailable')}</label><button className={styles.textButton} onClick={reset}>{t('filters.reset')}</button></div>}
      <div className={styles.chips}>{[ALL, ...facets.directions].map(d => <button key={d} data-active={direction === d} onClick={() => setDirection(d)}>{d === ALL ? t('filters.allDirections') : d}</button>)}</div>
      <div className={styles.resultsBar}><span>{t.rich('results.count', { count: tab === 'saved' ? saved.length : total, strong: chunks => <strong>{chunks}</strong> })} <span className={styles.resultSubtitle}>{t('results.subtitle')}</span>{loading && <span className={styles.loadingHint}>{t('results.loading')}</span>}</span><div><ArrowDownUp size={13} /><select aria-label={t('results.sortAria')} value={sort} onChange={e => setSort(e.target.value)}><option value="recommended">{t('results.sortRecommended')}</option><option value="stars">{t('results.sortStars')}</option><option value="activity">{t('results.sortActivity')}</option></select><span className={styles.divider} /><button aria-label={t('results.gridView')} aria-pressed={view === 'grid'} onClick={() => setView('grid')}><LayoutGrid size={16} /></button><button aria-label={t('results.listView')} aria-pressed={view === 'list'} onClick={() => setView('list')}><List size={18} /></button></div></div>
      {notice && <div className={styles.notice} role="status"><CheckCheck size={16} />{notice}<button onClick={() => setNotice('')} aria-label={t('notice.close')}><X size={14} /></button></div>}
      <div className={`${styles.grid} ${view === 'list' ? styles.list : ''}`}>
        {results.map(x => <article className={styles.card} key={x.id}>
          <button className={styles.cardHitArea} onClick={() => openTalent(x)} aria-label={t('card.viewProfileAria', { name: x.name })} />
          {x.cornerTag && <div className={styles.cornerRibbon} title={x.cornerTag}><span>{x.cornerTag}</span></div>}
          <div className={styles.cardTop}><div className={styles.identity}><TalentAvatar talent={x} badge /><span><strong>{x.name}</strong><small>{x.handle ? `@${x.handle}` : t('card.manual')}</small></span></div><button className={`${styles.bookmark}${x.cornerTag ? ` ${styles.bookmarkShift}` : ''}`} aria-label={saved.includes(x.id) ? t('card.unsaveAria', { name: x.name }) : t('card.saveAria', { name: x.name })} aria-pressed={saved.includes(x.id)} onClick={() => toggleSaved(x.id)}><Bookmark size={18} fill={saved.includes(x.id) ? 'currentColor' : 'none'} /></button></div>
          <h2>{x.role}</h2><p className={styles.bio}>{x.bio}</p><div className={styles.meta}><span><MapPin size={12} />{x.location}</span>{x.available ? <span className={styles.available}><i /> {t('card.available')}</span> : <span><Globe2 size={12} /> {x.pending ? t('card.pending') : t('card.community')}</span>}</div>
          <div className={styles.skills}>{x.officialTags?.map(s => <span key={s} className={styles.officialTag}><BadgeCheck size={11} />{s}</span>)}{x.skills.map(s => <span key={s}>{s}</span>)}</div>
          <div className={styles.project}><span><FolderGit2 size={15} /><strong>{x.project}</strong><ArrowUpRight size={14} /></span><small>{x.projectDescription}</small></div>
          <div className={styles.metrics}>{typeof x.score === "number" && x.score >= 60 && <span><Gauge size={13} /><strong>{x.score.toFixed(1)}</strong> {t('card.score')}</span>}<span><Star size={13} /><strong>{x.stars === null ? "—" : format(x.stars)}</strong> Stars</span><span><span className={styles.contributionIcon}>▥</span><strong>{x.contributions === null ? "—" : x.contributions.toLocaleString()}</strong> {t('card.yearlyContributions')}</span></div>
          <div className={styles.cardFooter}><span><Check size={12} />{x.source}</span><span className={styles.cardDetailLink}>{t('card.viewProfile')} <ArrowUpRight size={14} /></span></div>
        </article>)}
      </div>
      {tab === 'all' && hasMore && <div className={styles.loadMore}><button className={styles.secondary} onClick={loadMore} disabled={loading}>{t('results.loadMore')}</button></div>}
      {results.length === 0 && !loading && <div className={styles.empty}><Search size={28} /><h3>{tab === 'saved' && !saved.length ? t('empty.savedTitle') : t('empty.title')}</h3><p>{tab === 'saved' && !saved.length ? t('empty.savedBody') : t('empty.body')}</p><button className={styles.secondary} onClick={() => { reset(); setTab('all'); }}>{t('empty.browseAll')} <ArrowRight size={14} /></button></div>}
      <div className={styles.endline}><span /><p>{t('footer.endline')}</p><span /></div>
      <div className={styles.bottomNote}><GitFork size={17} /><p><strong>{t('footer.title')}</strong><br />{t('footer.body')}</p><span>{t('footer.source')}</span></div>
    </section>

    <Dialog open={!!selected} onOpenChange={open => { if (!open) setSelected(null); }}>
      <DialogContent className={styles.detail}>
        {selected && <TalentDetail talent={selected} saved={saved.includes(selected.id)} onSave={() => toggleSaved(selected.id)} />}
      </DialogContent>
    </Dialog>
    {adding && <TalentIntake busy={submitting} onClose={() => setAdding(false)} onAdd={addTalent} />}
  </main>;
}

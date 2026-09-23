'use client';

import { useEffect, useRef, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { ArrowDownUp, ArrowRight, ArrowUpRight, BadgeCheck, Bookmark, Check, CheckCheck, ChevronLeft, ChevronRight, Code2, FolderGit2, Gauge, GitFork, Globe2, LayoutGrid, List, MapPin, Plus, Search, SlidersHorizontal, Star, Users, X } from 'lucide-react';
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
export const ALL = 'all';

const PAGE_SIZES = [24, 48, 96];
// Mirrors DEFAULT_PAGE_SIZE in src/lib/talent-db.ts — keep in sync.
const DEFAULT_PAGE_SIZE = 24;
const GAP = -1;

export type TalentListPayload = { items: Talent[]; total: number; page: number; pageSize: number; hasMore: boolean };
export type TalentFacets = { directions: string[]; locations: string[] };

// Filter values mirrored into the URL query string so a filtered view can be
// refreshed or shared. Page index and size ride along in TalentListPayload.
export type TalentDirectoryFilters = {
  query: string;
  direction: string;
  location: string;
  source: string;
  available: boolean;
  sort: string;
};

const escapeRe = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Query tokens may carry a field prefix (`技能:Rust`); both the prefixed value
// and the free text are worth highlighting on the cards.
function queryTerms(query: string): string[] {
  return query.split(/\s+/)
    .map(token => {
      const match = token.match(/^[^\s:：]{1,16}[:：](.+)$/);
      return (match ? match[1] : token).trim();
    })
    .filter(term => term.length >= 2 || /[^\x00-\x7f]/.test(term))
    .slice(0, 8);
}

function Hi({ text, terms }: { text: string; terms: string[] }) {
  if (!text || !terms.length) return <>{text}</>;
  const re = new RegExp(`(${terms.map(escapeRe).join('|')})`, 'gi');
  return <>{text.split(re).map((part, i) => i % 2 ? <mark key={i} className={styles.mark}>{part}</mark> : part)}</>;
}

// Windowed pagination: first/last page plus the current neighborhood, with
// GAP markers where page numbers were skipped.
function pageList(totalPages: number, current: number): number[] {
  if (totalPages <= 7) return Array.from({ length: totalPages }, (_, i) => i);
  const pages = [...new Set([0, totalPages - 1, current - 1, current, current + 1])]
    .filter(p => p >= 0 && p < totalPages).sort((a, b) => a - b);
  const out: number[] = [];
  let prev = -1;
  for (const p of pages) { if (prev >= 0 && p - prev > 1) out.push(GAP); out.push(p); prev = p; }
  return out;
}

export function TalentDirectory({ initialList, initialTotal, facets, initialFilters }: { initialList: TalentListPayload; initialTotal: number; facets: TalentFacets; initialFilters: TalentDirectoryFilters }) {
  const t = useTranslations('talent');
  const locale = useLocale();
  const [items, setItems] = useState(initialList.items);
  const [total, setTotal] = useState(initialList.total);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState(initialFilters.query);
  const [debouncedQuery, setDebouncedQuery] = useState(initialFilters.query);
  const [direction, setDirection] = useState(initialFilters.direction);
  const [saved, setSaved] = useState<string[]>([]);
  const [savedItems, setSavedItems] = useState<Talent[] | null>(null);
  const [tab, setTab] = useState('all');
  const [filters, setFilters] = useState(false);
  const [location, setLocation] = useState(initialFilters.location);
  const [source, setSource] = useState(initialFilters.source);
  const [available, setAvailable] = useState(initialFilters.available);
  const [sort, setSort] = useState(initialFilters.sort);
  const [page, setPage] = useState(initialList.page);
  const [pageSize, setPageSize] = useState(initialList.pageSize);
  const [view, setView] = useState('grid');
  const [selected, setSelected] = useState<Talent | null>(null);
  const [adding, setAdding] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [notice, setNotice] = useState('');
  const requestSeq = useRef(0);
  const listTop = useRef<HTMLElement>(null);
  const toggleSaved = (id: string) => setSaved(prev => prev.includes(id) ? prev.filter(value => value !== id) : [...prev, id]);
  const reset = () => { setQuery(''); setDirection(ALL); setLocation(ALL); setSource(ALL); setAvailable(false); setPage(0); };

  // Any filter change restarts pagination from the first page.
  const onQuery = (value: string) => { setQuery(value); setPage(0); };
  const chooseDirection = (value: string) => { setDirection(value); setPage(0); };
  const chooseLocation = (value: string) => { setLocation(value); setPage(0); };
  const chooseSource = (value: string) => { setSource(value); setPage(0); };
  const chooseAvailable = (value: boolean) => { setAvailable(value); setPage(0); };
  const chooseSort = (value: string) => { setSort(value); setPage(0); };
  const choosePageSize = (value: number) => { setPageSize(value); setPage(0); };

  useEffect(() => { const timer = setTimeout(() => setDebouncedQuery(query.trim()), 300); return () => clearTimeout(timer); }, [query]);

  const buildUrl = (pageIndex: number) => {
    const params = new URLSearchParams({ locale, page: String(pageIndex), sort });
    if (debouncedQuery) params.set('q', debouncedQuery);
    if (direction !== ALL) params.set('direction', direction);
    if (location !== ALL) params.set('location', location);
    if (source !== ALL) params.set('source', source);
    if (available) params.set('available', '1');
    if (pageSize !== DEFAULT_PAGE_SIZE) params.set('pageSize', String(pageSize));
    return `/api/talent?${params.toString()}`;
  };

  // Mirror the current view into the query string — replaceState keeps this a
  // pure URL update (no router round-trip) so refresh/share restores it.
  const syncUrl = () => {
    const params = new URLSearchParams(window.location.search);
    for (const key of ['q', 'direction', 'location', 'source', 'available', 'sort', 'page', 'pageSize']) params.delete(key);
    if (debouncedQuery) params.set('q', debouncedQuery);
    if (direction !== ALL) params.set('direction', direction);
    if (location !== ALL) params.set('location', location);
    if (source !== ALL) params.set('source', source);
    if (available) params.set('available', '1');
    if (sort !== 'recommended') params.set('sort', sort);
    if (pageSize !== DEFAULT_PAGE_SIZE) params.set('pageSize', String(pageSize));
    if (page > 0) params.set('page', String(page + 1));
    const qs = params.toString();
    window.history.replaceState(null, '', qs ? `?${qs}` : window.location.pathname);
  };

  // Refetch whenever the server-side view changes. The initial server-rendered
  // page covers the first paint, so the mount pass only normalizes the URL.
  const requestKey = JSON.stringify([debouncedQuery, direction, location, source, available, sort, page, pageSize, locale]);
  const mounted = useRef(false);
  useEffect(() => {
    if (!mounted.current) { mounted.current = true; syncUrl(); return; }
    syncUrl();
    const seq = ++requestSeq.current;
    setLoading(true);
    fetch(buildUrl(page)).then(r => r.json()).then((data: TalentListPayload) => {
      if (seq !== requestSeq.current) return;
      setItems(data.items); setTotal(data.total); setPage(data.page); setPageSize(data.pageSize); setLoading(false);
    }).catch(() => { if (seq === requestSeq.current) setLoading(false); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestKey]);

  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const goToPage = (target: number) => {
    const next = Math.min(Math.max(0, target), totalPages - 1);
    if (next === page) return;
    setPage(next);
    listTop.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
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
  const terms = tab === 'all' ? queryTerms(debouncedQuery) : [];
  const activeFilters = Number(location !== ALL) + Number(source !== ALL) + Number(available);

  return <main className={styles.page}>
    <div className={styles.topline}><span>{t('topline.section')} <span className={styles.slash}>/</span> <strong>{t('topline.current')}</strong></span><span className={styles.preview}><span /> {t('topline.badge')}</span></div>
    <section className={styles.hero}>
      <h1>{t('hero.titleLead')}<br />{t('hero.titleVerb')}<span>{t('hero.titleAccent')}</span><span className={styles.heroAsterisk}>✳</span></h1>
      <p>{t('hero.subtitleLead')}<br className={styles.desktopBreak} /> {t('hero.subtitleTail')}</p>
      <div className={styles.heroBottom}><div className={styles.people}><div className={styles.miniAvatars}>{initialList.items.slice(0, 4).map(x => <TalentAvatar key={x.id} talent={x} />)}</div><span>{t('hero.people')}</span></div><button className={styles.primary} onClick={() => setAdding(true)}><Plus size={16} /> {t('hero.add')}</button></div>
      <div className={styles.heroCode} aria-hidden="true"><Code2 size={32} /><span>{t('hero.code')}</span><div><i /><i /><i /><i /><i /><i /><i /><i /><i /><i /><i /><i /><i /><i /><i /><i /><i /><i /></div></div>
    </section>

    <section className={styles.directory} aria-label={t('tabs.aria')} ref={listTop}>
      <div className={styles.tabs}><div><button data-active={tab === 'all'} onClick={() => setTab('all')}><Users size={16} /> {t('tabs.all')} <span>{initialTotal}</span></button><button data-active={tab === 'saved'} onClick={() => setTab('saved')}><Bookmark size={16} /> {t('tabs.saved')} <span>{saved.length}</span></button></div><span className={styles.sessionHint}>{t('tabs.sessionHint')}</span></div>
      <div className={styles.searchRow}><label className={styles.search}><Search size={19} /><input value={query} onChange={e => onQuery(e.target.value)} placeholder={t('search.placeholder')} aria-label={t('search.aria')} />{query && <button aria-label={t('search.clear')} onClick={() => onQuery('')}><X size={15} /></button>}</label><button className={styles.secondary} data-active={filters} onClick={() => setFilters(!filters)} aria-expanded={filters}><SlidersHorizontal size={16} /> {t('filters.toggle')} {activeFilters > 0 && <span>{activeFilters}</span>}</button></div>
      <p className={styles.searchHint}>{t('search.hint')}</p>
      {filters && <div className={styles.filters}><label>{t('filters.location')}<select value={location} onChange={e => chooseLocation(e.target.value)}>{[ALL, ...facets.locations].map(s => <option key={s} value={s}>{s === ALL ? t('filters.allLocations') : s}</option>)}</select></label><label>{t('filters.source')}<select value={source} onChange={e => chooseSource(e.target.value)}>{[[ALL, t('filters.allSources')], ['github', t('filters.sourceGithub')], ['manual', t('filters.sourceManual')]].map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label className={styles.checkbox}><input type="checkbox" checked={available} onChange={e => chooseAvailable(e.target.checked)} /> {t('filters.onlyAvailable')}</label><button className={styles.textButton} onClick={reset}>{t('filters.reset')}</button></div>}
      <div className={styles.chips}>{[ALL, ...facets.directions].map(d => <button key={d} data-active={direction === d} onClick={() => chooseDirection(d)}>{d === ALL ? t('filters.allDirections') : d}</button>)}</div>
      <div className={styles.resultsBar}><span>{t.rich('results.count', { count: tab === 'saved' ? saved.length : total, strong: chunks => <strong>{chunks}</strong> })} <span className={styles.resultSubtitle}>{t('results.subtitle')}</span>{loading && <span className={styles.loadingHint}>{t('results.loading')}</span>}</span><div><select aria-label={t('results.perPageAria')} value={pageSize} onChange={e => choosePageSize(Number(e.target.value))}>{PAGE_SIZES.map(n => <option key={n} value={n}>{t('results.perPageOption', { count: n })}</option>)}</select><span className={styles.divider} /><ArrowDownUp size={13} /><select aria-label={t('results.sortAria')} value={sort} onChange={e => chooseSort(e.target.value)}><option value="recommended">{t('results.sortRecommended')}</option><option value="stars">{t('results.sortStars')}</option><option value="activity">{t('results.sortActivity')}</option></select><span className={styles.divider} /><button aria-label={t('results.gridView')} aria-pressed={view === 'grid'} onClick={() => setView('grid')}><LayoutGrid size={16} /></button><button aria-label={t('results.listView')} aria-pressed={view === 'list'} onClick={() => setView('list')}><List size={18} /></button></div></div>
      {notice && <div className={styles.notice} role="status"><CheckCheck size={16} />{notice}<button onClick={() => setNotice('')} aria-label={t('notice.close')}><X size={14} /></button></div>}
      <div className={`${styles.grid} ${view === 'list' ? styles.list : ''}`}>
        {results.map(x => <article className={styles.card} key={x.id}>
          <button className={styles.cardHitArea} onClick={() => openTalent(x)} aria-label={t('card.viewProfileAria', { name: x.name })} />
          {x.cornerTag && <div className={styles.cornerRibbon} title={x.cornerTag}><span>{x.cornerTag}</span></div>}
          <div className={styles.cardTop}><div className={styles.identity}><TalentAvatar talent={x} badge /><span><strong><Hi text={x.name} terms={terms} /></strong><small>{x.handle ? <>@<Hi text={x.handle} terms={terms} /></> : t('card.manual')}</small></span></div><button className={`${styles.bookmark}${x.cornerTag ? ` ${styles.bookmarkShift}` : ''}`} aria-label={saved.includes(x.id) ? t('card.unsaveAria', { name: x.name }) : t('card.saveAria', { name: x.name })} aria-pressed={saved.includes(x.id)} onClick={() => toggleSaved(x.id)}><Bookmark size={18} fill={saved.includes(x.id) ? 'currentColor' : 'none'} /></button></div>
          <h2><Hi text={x.role} terms={terms} /></h2><p className={styles.bio}><Hi text={x.bio} terms={terms} /></p><div className={styles.meta}><span><MapPin size={12} /><Hi text={x.location} terms={terms} /></span>{x.available ? <span className={styles.available}><i /> {t('card.available')}</span> : <span><Globe2 size={12} /> {x.pending ? t('card.pending') : t('card.community')}</span>}</div>
          <div className={styles.skills}>{x.officialTags?.map(s => <span key={s} className={styles.officialTag}><BadgeCheck size={11} />{s}</span>)}{x.skills.map(s => <span key={s}><Hi text={s} terms={terms} /></span>)}</div>
          <div className={styles.project}><span><FolderGit2 size={15} /><strong><Hi text={x.project} terms={terms} /></strong><ArrowUpRight size={14} /></span><small><Hi text={x.projectDescription} terms={terms} /></small></div>
          <div className={styles.metrics}>{typeof x.score === "number" && x.score >= 60 && <span><Gauge size={13} /><strong>{x.score.toFixed(1)}</strong> {t('card.score')}</span>}<span><Star size={13} /><strong>{x.stars === null ? "—" : format(x.stars)}</strong> Stars</span><span><span className={styles.contributionIcon}>▥</span><strong>{x.contributions === null ? "—" : x.contributions.toLocaleString()}</strong> {t('card.yearlyContributions')}</span></div>
          <div className={styles.cardFooter}><span><Check size={12} />{x.source}</span><span className={styles.cardDetailLink}>{t('card.viewProfile')} <ArrowUpRight size={14} /></span></div>
        </article>)}
      </div>
      {tab === 'all' && totalPages > 1 && <nav className={styles.pagination} aria-label={t('results.pagesAria')}>
        <button className={styles.pageBtn} onClick={() => goToPage(page - 1)} disabled={page === 0} aria-label={t('results.prevPage')}><ChevronLeft size={15} /></button>
        {pageList(totalPages, page).map((p, i) => p === GAP
          ? <span key={`gap-${i}`} className={styles.pageGap}>…</span>
          : <button key={p} className={styles.pageBtn} data-active={p === page} aria-current={p === page ? 'page' : undefined} onClick={() => goToPage(p)}>{p + 1}</button>)}
        <button className={styles.pageBtn} onClick={() => goToPage(page + 1)} disabled={page >= totalPages - 1} aria-label={t('results.nextPage')}><ChevronRight size={15} /></button>
        <span className={styles.pageStatus}>{t('results.pageStatus', { page: page + 1, pages: totalPages })}</span>
      </nav>}
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

'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { ArrowDownUp, ArrowRight, ArrowUpRight, Bookmark, Check, CheckCheck, Code2, FolderGit2, Gauge, GitFork, Globe2, LayoutGrid, List, MapPin, Plus, Search, SlidersHorizontal, Star, Users, X } from 'lucide-react';
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

export function TalentDirectory({ initialTalents }: { initialTalents: Talent[] }) {
  const t = useTranslations('talent');
  const [talents] = useState(initialTalents);
  const [query, setQuery] = useState('');
  const [direction, setDirection] = useState(ALL);
  const [saved, setSaved] = useState<string[]>([]);
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
  const toggleSaved = (id: string) => setSaved(prev => prev.includes(id) ? prev.filter(value => value !== id) : [...prev, id]);
  const openTalent = (talent: Talent) => { setSelected(talent); };
  const reset = () => { setQuery(''); setDirection(ALL); setLocation(ALL); setSource(ALL); setAvailable(false); };
  const directions = [ALL, ...new Set(talents.map(x => x.direction))];
  const activeFilters = Number(location !== ALL) + Number(source !== ALL) + Number(available);
  const results = talents.filter(x => (tab !== 'saved' || saved.includes(x.id)) && (direction === ALL || x.direction === direction) && (location === ALL || x.location === location) && (source === ALL || x.source.includes(source === 'github' ? 'GitHub' : '人工整理')) && (!available || x.available) && [x.name, x.handle, x.role, x.bio, x.location, ...x.skills].join(' ').toLowerCase().includes(query.trim().toLowerCase())).sort((a, b) => sort === 'stars' ? (b.stars ?? -1) - (a.stars ?? -1) : sort === 'activity' ? (b.contributions ?? -1) - (a.contributions ?? -1) : 0);

  async function addTalent(talent: Talent) {
    setSubmitting(true);
    const result = await submitTalentIntake(talent);
    setSubmitting(false);
    if (!result.ok) { setNotice(result.message); return; }
    setAdding(false); reset(); setTab('all'); setSort('recommended');
    setNotice(t('notice.submitted', { name: talent.name }));
  }

  return <main className={styles.page}>
    <div className={styles.topline}><span>{t('topline.section')} <span className={styles.slash}>/</span> <strong>{t('topline.current')}</strong></span><span className={styles.preview}><span /> {t('topline.badge')}</span></div>
    <section className={styles.hero}>
      <h1>{t('hero.titleLead')}<br />{t('hero.titleVerb')}<span>{t('hero.titleAccent')}</span><span className={styles.heroAsterisk}>✳</span></h1>
      <p>{t('hero.subtitleLead')}<br className={styles.desktopBreak} /> {t('hero.subtitleTail')}</p>
      <div className={styles.heroBottom}><div className={styles.people}><div className={styles.miniAvatars}>{talents.slice(0, 4).map(x => <TalentAvatar key={x.id} talent={x} />)}</div><span>{t('hero.people')}</span></div><button className={styles.primary} onClick={() => setAdding(true)}><Plus size={16} /> {t('hero.add')}</button></div>
      <div className={styles.heroCode} aria-hidden="true"><Code2 size={32} /><span>{t('hero.code')}</span><div><i /><i /><i /><i /><i /><i /><i /><i /><i /><i /><i /><i /><i /><i /><i /><i /><i /><i /></div></div>
    </section>

    <section className={styles.directory} aria-label={t('tabs.aria')}>
      <div className={styles.tabs}><div><button data-active={tab === 'all'} onClick={() => setTab('all')}><Users size={16} /> {t('tabs.all')} <span>{talents.length}</span></button><button data-active={tab === 'saved'} onClick={() => setTab('saved')}><Bookmark size={16} /> {t('tabs.saved')} <span>{saved.length}</span></button></div><span className={styles.sessionHint}>{t('tabs.sessionHint')}</span></div>
      <div className={styles.searchRow}><label className={styles.search}><Search size={19} /><input value={query} onChange={e => setQuery(e.target.value)} placeholder={t('search.placeholder')} aria-label={t('search.aria')} />{query && <button aria-label={t('search.clear')} onClick={() => setQuery('')}><X size={15} /></button>}</label><button className={styles.secondary} data-active={filters} onClick={() => setFilters(!filters)} aria-expanded={filters}><SlidersHorizontal size={16} /> {t('filters.toggle')} {activeFilters > 0 && <span>{activeFilters}</span>}</button></div>
      {filters && <div className={styles.filters}><label>{t('filters.location')}<select value={location} onChange={e => setLocation(e.target.value)}>{[ALL, ...new Set(talents.map(x => x.location))].map(s => <option key={s} value={s}>{s === ALL ? t('filters.allLocations') : s}</option>)}</select></label><label>{t('filters.source')}<select value={source} onChange={e => setSource(e.target.value)}>{[[ALL, t('filters.allSources')], ['github', t('filters.sourceGithub')], ['manual', t('filters.sourceManual')]].map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label className={styles.checkbox}><input type="checkbox" checked={available} onChange={e => setAvailable(e.target.checked)} /> {t('filters.onlyAvailable')}</label><button className={styles.textButton} onClick={reset}>{t('filters.reset')}</button></div>}
      <div className={styles.chips}>{directions.map(d => <button key={d} data-active={direction === d} onClick={() => setDirection(d)}>{d === ALL ? t('filters.allDirections') : d}</button>)}</div>
      <div className={styles.resultsBar}><span>{t.rich('results.count', { count: results.length, strong: chunks => <strong>{chunks}</strong> })} <span className={styles.resultSubtitle}>{t('results.subtitle')}</span></span><div><ArrowDownUp size={13} /><select aria-label={t('results.sortAria')} value={sort} onChange={e => setSort(e.target.value)}><option value="recommended">{t('results.sortRecommended')}</option><option value="stars">{t('results.sortStars')}</option><option value="activity">{t('results.sortActivity')}</option></select><span className={styles.divider} /><button aria-label={t('results.gridView')} aria-pressed={view === 'grid'} onClick={() => setView('grid')}><LayoutGrid size={16} /></button><button aria-label={t('results.listView')} aria-pressed={view === 'list'} onClick={() => setView('list')}><List size={18} /></button></div></div>
      {notice && <div className={styles.notice} role="status"><CheckCheck size={16} />{notice}<button onClick={() => setNotice('')} aria-label={t('notice.close')}><X size={14} /></button></div>}
      <div className={`${styles.grid} ${view === 'list' ? styles.list : ''}`}>
        {results.map(x => <article className={styles.card} key={x.id}>
          <button className={styles.cardHitArea} onClick={() => openTalent(x)} aria-label={t('card.viewProfileAria', { name: x.name })} />
          <div className={styles.cardTop}><div className={styles.identity}><TalentAvatar talent={x} badge /><span><strong>{x.name}</strong><small>{x.handle ? `@${x.handle}` : t('card.manual')}</small></span></div><button className={styles.bookmark} aria-label={saved.includes(x.id) ? t('card.unsaveAria', { name: x.name }) : t('card.saveAria', { name: x.name })} aria-pressed={saved.includes(x.id)} onClick={() => toggleSaved(x.id)}><Bookmark size={18} fill={saved.includes(x.id) ? 'currentColor' : 'none'} /></button></div>
          <h2>{x.role}</h2><p className={styles.bio}>{x.bio}</p><div className={styles.meta}><span><MapPin size={12} />{x.location}</span>{x.available ? <span className={styles.available}><i /> {t('card.available')}</span> : <span><Globe2 size={12} /> {x.pending ? t('card.pending') : t('card.community')}</span>}</div>
          <div className={styles.skills}>{x.skills.map(s => <span key={s}>{s}</span>)}</div>
          <div className={styles.project}><span><FolderGit2 size={15} /><strong>{x.project}</strong><ArrowUpRight size={14} /></span><small>{x.projectDescription}</small></div>
          <div className={styles.metrics}>{typeof x.score === "number" && x.score >= 60 && <span><Gauge size={13} /><strong>{x.score.toFixed(1)}</strong> {t('card.score')}</span>}<span><Star size={13} /><strong>{x.stars === null ? "—" : format(x.stars)}</strong> Stars</span><span><span className={styles.contributionIcon}>▥</span><strong>{x.contributions === null ? "—" : x.contributions.toLocaleString()}</strong> {t('card.yearlyContributions')}</span></div>
          <div className={styles.cardFooter}><span><Check size={12} />{x.source}</span><span className={styles.cardDetailLink}>{t('card.viewProfile')} <ArrowUpRight size={14} /></span></div>
        </article>)}
      </div>
      {results.length === 0 && <div className={styles.empty}><Search size={28} /><h3>{tab === 'saved' && !saved.length ? t('empty.savedTitle') : t('empty.title')}</h3><p>{tab === 'saved' && !saved.length ? t('empty.savedBody') : t('empty.body')}</p><button className={styles.secondary} onClick={() => { reset(); setTab('all'); }}>{t('empty.browseAll')} <ArrowRight size={14} /></button></div>}
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

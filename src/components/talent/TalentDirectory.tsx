'use client';

import { useState } from 'react';
import { ArrowDownUp, ArrowRight, ArrowUpRight, Bookmark, Check, CheckCheck, Code2, FolderGit2, GitFork, Globe2, LayoutGrid, List, MapPin, Plus, Search, SlidersHorizontal, Star, Users, X } from 'lucide-react';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import type { Talent } from './data';
import { TalentAvatar } from './TalentAvatar';
import styles from './talent.module.css';
import { TalentIntake } from './TalentIntake';
import { TalentDetail } from './TalentDetail';
import { submitTalentIntake } from './actions';

const format = (n: number) => n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);

export function TalentDirectory({ initialTalents }: { initialTalents: Talent[] }) {
  const [talents] = useState(initialTalents);
  const [query, setQuery] = useState('');
  const [direction, setDirection] = useState('全部方向');
  const [saved, setSaved] = useState<string[]>([]);
  const [tab, setTab] = useState('all');
  const [filters, setFilters] = useState(false);
  const [location, setLocation] = useState('全部地点');
  const [source, setSource] = useState('全部来源');
  const [available, setAvailable] = useState(false);
  const [sort, setSort] = useState('recommended');
  const [view, setView] = useState('grid');
  const [selected, setSelected] = useState<Talent | null>(null);
  const [adding, setAdding] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [notice, setNotice] = useState('');
  const toggleSaved = (id: string) => setSaved(prev => prev.includes(id) ? prev.filter(value => value !== id) : [...prev, id]);
  const openTalent = (talent: Talent) => { setSelected(talent); };
  const reset = () => { setQuery(''); setDirection('全部方向'); setLocation('全部地点'); setSource('全部来源'); setAvailable(false); };
  const directions = ['全部方向', ...new Set(talents.map(t => t.direction))];
  const activeFilters = Number(location !== '全部地点') + Number(source !== '全部来源') + Number(available);
  const results = talents.filter(t => (tab !== 'saved' || saved.includes(t.id)) && (direction === '全部方向' || t.direction === direction) && (location === '全部地点' || t.location === location) && (source === '全部来源' || t.source.includes(source)) && (!available || t.available) && [t.name, t.handle, t.role, t.bio, t.location, ...t.skills].join(' ').toLowerCase().includes(query.trim().toLowerCase())).sort((a, b) => sort === 'stars' ? (b.stars ?? -1) - (a.stars ?? -1) : sort === 'activity' ? (b.contributions ?? -1) - (a.contributions ?? -1) : 0);

  async function addTalent(talent: Talent) {
    setSubmitting(true);
    const result = await submitTalentIntake(talent);
    setSubmitting(false);
    if (!result.ok) { setNotice(result.message); return; }
    setAdding(false); reset(); setTab('all'); setSort('recommended');
    setNotice(`已收到对 ${talent.name} 的收录提交，仅保留公开字段，审核通过后展示。`);
  }

  return <main className={styles.page}>
    <div className={styles.topline}><span>职业发展 <span className={styles.slash}>/</span> <strong>人才库</strong></span><span className={styles.preview}><span /> 社区收录 · 持续更新</span></div>
    <section className={styles.hero}>
      <h1>从一行代码，<br />发现<span>值得认识的人。</span><span className={styles.heroAsterisk}>✳</span></h1>
      <p>不止是一份简历。透过开源项目、技术实践与真实作品，<br className={styles.desktopBreak} /> 认识开发者，也找到下一位同行者。</p>
      <div className={styles.heroBottom}><div className={styles.people}><div className={styles.miniAvatars}>{talents.slice(0, 4).map(t => <TalentAvatar key={t.id} talent={t} />)}</div><span>以 GitHub 为起点，连接更多可能</span></div><button className={styles.primary} onClick={() => setAdding(true)}><Plus size={16} /> 收录人才</button></div>
      <div className={styles.heroCode} aria-hidden="true"><Code2 size={32} /><span>built by humans.</span><div><i /><i /><i /><i /><i /><i /><i /><i /><i /><i /><i /><i /><i /><i /><i /><i /><i /><i /></div></div>
    </section>

    <section className={styles.directory} aria-label="人才发现">
      <div className={styles.tabs}><div><button data-active={tab === 'all'} onClick={() => setTab('all')}><Users size={16} /> 发现人才 <span>{talents.length}</span></button><button data-active={tab === 'saved'} onClick={() => setTab('saved')}><Bookmark size={16} /> 我的收藏 <span>{saved.length}</span></button></div><span className={styles.sessionHint}>收藏仅在本次浏览中保留</span></div>
      <div className={styles.searchRow}><label className={styles.search}><Search size={19} /><input value={query} onChange={e => setQuery(e.target.value)} placeholder="搜索姓名、GitHub 用户名、技术栈或城市…" aria-label="搜索人才" />{query && <button aria-label="清空搜索" onClick={() => setQuery('')}><X size={15} /></button>}</label><button className={styles.secondary} data-active={filters} onClick={() => setFilters(!filters)} aria-expanded={filters}><SlidersHorizontal size={16} /> 筛选 {activeFilters > 0 && <span>{activeFilters}</span>}</button></div>
      {filters && <div className={styles.filters}><label>所在地点<select value={location} onChange={e => setLocation(e.target.value)}>{['全部地点', ...new Set(talents.map(t => t.location))].map(s => <option key={s}>{s}</option>)}</select></label><label>数据来源<select value={source} onChange={e => setSource(e.target.value)}>{['全部来源', 'GitHub', '人工整理'].map(s => <option key={s}>{s}</option>)}</select></label><label className={styles.checkbox}><input type="checkbox" checked={available} onChange={e => setAvailable(e.target.checked)} /> 仅看愿意交流的人才</label><button className={styles.textButton} onClick={reset}>重置筛选</button></div>}
      <div className={styles.chips}>{directions.map(d => <button key={d} data-active={direction === d} onClick={() => setDirection(d)}>{d}</button>)}</div>
      <div className={styles.resultsBar}><span>发现 <strong>{results.length}</strong> 位开发者 <span className={styles.resultSubtitle}>· 从作品开始了解</span></span><div><ArrowDownUp size={13} /><select aria-label="人才排序" value={sort} onChange={e => setSort(e.target.value)}><option value="recommended">精选排序</option><option value="stars">项目 Stars 优先</option><option value="activity">贡献活跃度优先</option></select><span className={styles.divider} /><button aria-label="卡片视图" aria-pressed={view === 'grid'} onClick={() => setView('grid')}><LayoutGrid size={16} /></button><button aria-label="列表视图" aria-pressed={view === 'list'} onClick={() => setView('list')}><List size={18} /></button></div></div>
      {notice && <div className={styles.notice} role="status"><CheckCheck size={16} />{notice}<button onClick={() => setNotice('')} aria-label="关闭提示"><X size={14} /></button></div>}
      <div className={`${styles.grid} ${view === 'list' ? styles.list : ''}`}>
        {results.map(t => <article className={styles.card} key={t.id}>
          <button className={styles.cardHitArea} onClick={() => openTalent(t)} aria-label={`查看${t.name}档案`} />
          <div className={styles.cardTop}><div className={styles.identity}><TalentAvatar talent={t} badge /><span><strong>{t.name}</strong><small>{t.handle ? `@${t.handle}` : "手动收录"}</small></span></div><button className={styles.bookmark} aria-label={`${saved.includes(t.id) ? '取消收藏' : '收藏'}${t.name}`} aria-pressed={saved.includes(t.id)} onClick={() => toggleSaved(t.id)}><Bookmark size={18} fill={saved.includes(t.id) ? 'currentColor' : 'none'} /></button></div>
          <h2>{t.role}</h2><p className={styles.bio}>{t.bio}</p><div className={styles.meta}><span><MapPin size={12} />{t.location}</span>{t.available ? <span className={styles.available}><i /> 愿意交流</span> : <span><Globe2 size={12} /> {t.pending ? "资料待补充" : "活跃于开源社区"}</span>}</div>
          <div className={styles.skills}>{t.skills.map(s => <span key={s}>{s}</span>)}</div>
          <div className={styles.project}><span><FolderGit2 size={15} /><strong>{t.project}</strong><ArrowUpRight size={14} /></span><small>{t.projectDescription}</small></div>
          <div className={styles.metrics}><span><Star size={13} /><strong>{t.stars === null ? "—" : format(t.stars)}</strong> Stars</span><span><span className={styles.contributionIcon}>▥</span><strong>{t.contributions === null ? "—" : t.contributions.toLocaleString()}</strong> 年贡献</span></div>
          <div className={styles.cardFooter}><span><Check size={12} />{t.source}</span><span className={styles.cardDetailLink}>查看档案 <ArrowUpRight size={14} /></span></div>
        </article>)}
      </div>
      {results.length === 0 && <div className={styles.empty}><Search size={28} /><h3>{tab === 'saved' && !saved.length ? '把想进一步了解的人，留在这里' : '暂时没有匹配的人才'}</h3><p>{tab === 'saved' && !saved.length ? '点击人才卡片右上角的收藏图标，建立你的候选清单。' : '试试其他技术栈，或放宽筛选条件。'}</p><button className={styles.secondary} onClick={() => { reset(); setTab('all'); }}>浏览全部人才 <ArrowRight size={14} /></button></div>}
      <div className={styles.endline}><span /><p>好的人才，值得被看见</p><span /></div>
      <div className={styles.bottomNote}><GitFork size={17} /><p><strong>源于开源，不止于开源</strong><br />GitHub 公开信息 × 人工精选补充，让每一份才华都有迹可循。</p><span>数据来源于 GitHub 公开信息与站内合集</span></div>
    </section>

    <Dialog open={!!selected} onOpenChange={open => { if (!open) setSelected(null); }}>
      <DialogContent className={styles.detail}>
        {selected && <TalentDetail talent={selected} saved={saved.includes(selected.id)} onSave={() => toggleSaved(selected.id)} />}
      </DialogContent>
    </Dialog>
    {adding && <TalentIntake busy={submitting} onClose={() => setAdding(false)} onAdd={addTalent} />}
  </main>;
}

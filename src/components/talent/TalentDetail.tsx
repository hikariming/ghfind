'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Bookmark, Code2, FileText, FolderGit2, GitFork, GitPullRequest, Globe2, LockKeyhole, Mail, MapPin, MessageCircle, Phone, Sparkles, X } from 'lucide-react';
import { DialogClose, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Link } from '@/i18n/navigation';
import { profileFields, type Field } from './intake';
import type { Talent } from './data';
import { TalentAvatar } from './TalentAvatar';
import styles from './talent.module.css';

function SourceLink({ url, children }: { url?: string; children: React.ReactNode }) {
  if (url?.startsWith('/collections/')) return <Link className={styles.sourceLink} href={url}>{children} ↗</Link>;
  if (url && /^https:\/\//.test(url)) return <a className={styles.sourceLink} href={url} target="_blank" rel="noopener noreferrer">{children} ↗</a>;
  return <>{children}</>;
}

export function TalentDetail({ talent: t, saved, onSave }: { talent: Talent; saved: boolean; onSave: () => void }) {
  const tr = useTranslations('talent');
  const [tab, setTab] = useState('overview');
  const tags = t.tags ?? t.skills;
  const contacts = ([['email', Mail], ['wechat', MessageCircle], ['phone', Phone]] as const).filter(([key]) => !!t.publicFields?.[key]);
  const fields = profileFields.filter(key => !['email', 'wechat', 'phone'].includes(key) && t.publicFields?.[key]);
  const fieldLabel = (key: Field) => tr(`fields.${key}`);
  return <>
    <DialogClose className={styles.close} aria-label={tr('detail.close')}><X size={19} /></DialogClose>
    <div className={styles.detailEyebrow}>{tr('detail.eyebrow')} <span>{t.pending ? tr('detail.pendingBadge') : tr('detail.listedBadge')}</span></div>
    <div className={styles.detailHeader}><TalentAvatar talent={t} /><div><DialogTitle className={styles.detailTitle}>{t.name}</DialogTitle><span>{t.handle ? `@${t.handle} · ` : ''}{t.role}</span></div><button className={`${styles.secondary} ${styles.detailSave}`} onClick={onSave} aria-pressed={saved}><Bookmark size={15} fill={saved ? 'currentColor' : 'none'} />{saved ? tr('detail.saved') : tr('detail.save')}</button></div>
    <DialogDescription className={styles.detailDescription}>{t.bio}</DialogDescription>
    <div className={styles.profileTags} aria-label={tr('detail.tagsAria')}><span><MapPin size={13} />{t.location}</span>{t.handle && <span><GitFork size={13} />{t.handle}</span>}{tags.map(tag => <span key={tag}><Code2 size={12} />{tag}</span>)}</div>
    <div className={styles.profileColumns}>
      <section className={styles.profilePanel} aria-label={tr('detail.projectsAria')}><div className={styles.panelHeading}><h3><FolderGit2 size={17} />{tr('detail.projectsTitle')}</h3><span>{tr('detail.projectsCount', { count: t.projects?.length ?? 0 })}</span></div>
        {t.projects?.length ? t.projects.map(p => <div className={styles.projectRecord} key={p.name}><div><strong><SourceLink url={p.url}>{p.name}</SourceLink></strong><span className={styles.relationTag} data-kind={p.relationship}>{p.relationship === 'own' ? <Code2 size={11} /> : <GitPullRequest size={11} />}{p.relationship === 'own' ? tr('detail.relOwn') : tr('detail.relPr')}</span></div><p>{p.description}</p><small>{p.contribution}</small></div>) : <div className={styles.panelEmpty}><FolderGit2 size={22} /><p>{tr('detail.projectsEmpty')}</p><small>{tr('detail.projectsEmptyHint')}</small></div>}
      </section>
      <section className={styles.profilePanel} aria-label={tr('detail.sourcesAria')}><div className={styles.panelHeading}><h3><Globe2 size={17} />{tr('detail.sourcesTitle')}</h3><span>{t.pending ? tr('detail.sourcesPending') : tr('detail.sourcesCount', { count: t.sources?.length ?? 0 })}</span></div>
        {t.sources?.length ? t.sources.map(s => { const Icon = s.kind === 'github' ? GitFork : s.kind === 'article' ? FileText : Globe2; return <div className={styles.evidenceRecord} key={s.title}><span className={styles.evidenceIcon}><Icon size={16} /></span><div><small>{s.publisher}</small><strong><SourceLink url={s.url}>{s.title}</SourceLink></strong><p>{s.description}</p></div></div>; }) : <div className={styles.panelEmpty}><Globe2 size={22} /><p>{t.handle ? `GitHub · @${t.handle}` : tr('detail.sourcesEmptyManual')}</p><small>{tr('detail.sourcesEmptyHint')}</small></div>}
      </section>
    </div>
    <div className={styles.detailTabs} role="tablist" aria-label={tr('detail.tabsAria')}>{[['overview', tr('detail.tabOverview')], ['contacts', tr('detail.tabContacts')]].map(([key, label]) => <button key={key} role="tab" id={`talent-tab-${key}`} aria-controls={`talent-panel-${key}`} aria-selected={tab === key} data-active={tab === key} onClick={() => setTab(key)}>{label}</button>)}</div>
    <div role="tabpanel" id={`talent-panel-${tab}`} aria-labelledby={`talent-tab-${tab}`} className={styles.detailBody}>
      {tab === 'overview' ? <><section className={styles.editorNote}><h3><Sparkles size={15} />{tr('detail.editorNote')}</h3><p>{t.note}</p></section>{fields.length > 0 && <section><h3>{tr('detail.publicInfo')}</h3><dl className={styles.publicFields}>{fields.map(key => <div key={key}><dt>{fieldLabel(key)}</dt><dd>{t.publicFields?.[key]}</dd></div>)}</dl></section>}</> : <><h3>{tr('detail.contactTitle', { name: t.name })}</h3><p>{tr('detail.contactHint')}</p>{contacts.length ? <dl className={styles.contactList}>{contacts.map(([key, Icon]) => <div key={key}><dt><Icon size={16} />{fieldLabel(key)}</dt><dd>{t.publicFields?.[key]}</dd></div>)}</dl> : <div className={styles.contactEmpty}><LockKeyhole size={21} /><div><strong>{tr('detail.contactEmptyTitle')}</strong><p>{tr('detail.contactEmptyBody')}</p></div></div>}</>}
    </div>
  </>;
}

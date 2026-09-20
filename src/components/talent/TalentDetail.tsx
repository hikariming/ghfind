'use client';

import { useState } from 'react';
import { Bookmark, Code2, FileText, FolderGit2, GitFork, GitPullRequest, Globe2, LockKeyhole, Mail, MapPin, MessageCircle, Phone, Sparkles, X } from 'lucide-react';
import { DialogClose, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Link } from '@/i18n/navigation';
import { profileFields } from './intake';
import type { Talent } from './data';
import { TalentAvatar } from './TalentAvatar';
import styles from './talent.module.css';

function SourceLink({ url, children }: { url?: string; children: React.ReactNode }) {
  if (url?.startsWith('/collections/')) return <Link className={styles.sourceLink} href={url}>{children} ↗</Link>;
  if (url && /^https:\/\//.test(url)) return <a className={styles.sourceLink} href={url} target="_blank" rel="noopener noreferrer">{children} ↗</a>;
  return <>{children}</>;
}

export function TalentDetail({ talent: t, saved, onSave }: { talent: Talent; saved: boolean; onSave: () => void }) {
  const [tab, setTab] = useState('overview');
  const tags = t.tags ?? t.skills;
  const contacts = ([['email', '邮箱', Mail], ['wechat', '微信', MessageCircle], ['phone', '电话', Phone]] as const).filter(([key]) => !!t.publicFields?.[key]);
  const fields = profileFields.filter(([key]) => !['email', 'wechat', 'phone'].includes(key) && t.publicFields?.[key]);
  return <>
    <DialogClose className={styles.close} aria-label="关闭档案"><X size={19} /></DialogClose>
    <div className={styles.detailEyebrow}>DEVELOPER PROFILE <span>{t.pending ? '待审核档案' : '收录档案'}</span></div>
    <div className={styles.detailHeader}><TalentAvatar talent={t} /><div><DialogTitle className={styles.detailTitle}>{t.name}</DialogTitle><span>{t.handle ? `@${t.handle} · ` : ''}{t.role}</span></div><button className={`${styles.secondary} ${styles.detailSave}`} onClick={onSave} aria-pressed={saved}><Bookmark size={15} fill={saved ? 'currentColor' : 'none'} />{saved ? '已收藏' : '收藏人才'}</button></div>
    <DialogDescription className={styles.detailDescription}>{t.bio}</DialogDescription>
    <div className={styles.profileTags} aria-label="人才标签"><span><MapPin size={13} />{t.location}</span>{t.handle && <span><GitFork size={13} />{t.handle}</span>}{tags.map(tag => <span key={tag}><Code2 size={12} />{tag}</span>)}</div>
    <div className={styles.profileColumns}>
      <section className={styles.profilePanel} aria-label="代表项目"><div className={styles.panelHeading}><h3><FolderGit2 size={17} />代表项目</h3><span>{t.projects?.length ?? 0} 个项目</span></div>
        {t.projects?.length ? t.projects.map(p => <div className={styles.projectRecord} key={p.name}><div><strong><SourceLink url={p.url}>{p.name}</SourceLink></strong><span className={styles.relationTag} data-kind={p.relationship}>{p.relationship === 'own' ? <Code2 size={11} /> : <GitPullRequest size={11} />}{p.relationship === 'own' ? '自有项目' : '参与贡献'}</span></div><p>{p.description}</p><small>{p.contribution}</small></div>) : <div className={styles.panelEmpty}><FolderGit2 size={22} /><p>暂未关联代表项目</p><small>后续可添加自有仓库或参与贡献的 PR。</small></div>}
      </section>
      <section className={styles.profilePanel} aria-label="信息来源"><div className={styles.panelHeading}><h3><Globe2 size={17} />信息来源</h3><span>{t.pending ? '待补充' : `${t.sources?.length ?? 0} 个来源`}</span></div>
        {t.sources?.length ? t.sources.map(s => { const Icon = s.kind === 'github' ? GitFork : s.kind === 'article' ? FileText : Globe2; return <div className={styles.evidenceRecord} key={s.title}><span className={styles.evidenceIcon}><Icon size={16} /></span><div><small>{s.publisher}</small><strong><SourceLink url={s.url}>{s.title}</SourceLink></strong><p>{s.description}</p></div></div>; }) : <div className={styles.panelEmpty}><Globe2 size={22} /><p>{t.handle ? `GitHub · @${t.handle}` : '人工收录'}</p><small>尚未关联来源，可补充 GitHub、个人网站或相关报道。</small></div>}
      </section>
    </div>
    <div className={styles.detailTabs} role="tablist" aria-label="档案内容">{[['overview', '人才概览'], ['contacts', '联系方式']].map(([key, label]) => <button key={key} role="tab" id={`talent-tab-${key}`} aria-controls={`talent-panel-${key}`} aria-selected={tab === key} data-active={tab === key} onClick={() => setTab(key)}>{label}</button>)}</div>
    <div role="tabpanel" id={`talent-panel-${tab}`} aria-labelledby={`talent-tab-${tab}`} className={styles.detailBody}>
      {tab === 'overview' ? <><section className={styles.editorNote}><h3><Sparkles size={15} />收录者手记</h3><p>{t.note}</p></section>{fields.length > 0 && <section><h3>公开资料</h3><dl className={styles.publicFields}>{fields.map(([key, label]) => <div key={key}><dt>{label}</dt><dd>{t.publicFields?.[key]}</dd></div>)}</dl></section>}</> : <><h3>与 {t.name} 取得联系</h3><p>仅展示本人选择公开的联系方式。</p>{contacts.length ? <dl className={styles.contactList}>{contacts.map(([key, label, Icon]) => <div key={key}><dt><Icon size={16} />{label}</dt><dd>{t.publicFields?.[key]}</dd></div>)}</dl> : <div className={styles.contactEmpty}><LockKeyhole size={21} /><div><strong>暂未公开联系方式</strong><p>本人可在收录自己的流程中，选择公开微信、邮箱或电话。</p></div></div>}</>}
    </div>
  </>;
}

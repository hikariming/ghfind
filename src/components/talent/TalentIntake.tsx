'use client';

import { useState, type FormEvent } from 'react';
import { ArrowLeft, ArrowRight, Check, FileUser, GitFork, LockKeyhole, UserRound, Users, X } from 'lucide-react';
import { Link } from '@/i18n/navigation';
import { readResumeLibraryFull, RESUME_STORAGE_KEY, type Profile, type Resume } from '@/lib/resume';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { emptyIntake, importResume, normalizeHandle, profileFields, publicTalent } from './intake';
import type { Talent } from './data';
import styles from './talent.module.css';

type ResumeChoice = { id: string; label: string; data: Resume | Profile };
export function TalentIntake({ busy, onClose, onAdd }: { busy: boolean; onClose: () => void; onAdd: (talent: Talent) => void | Promise<void> }) {
  const [step, setStep] = useState(0);
  const [self, setSelf] = useState(true);
  const [method, setMethod] = useState<'github' | 'manual'>('github');
  const [draft, setDraft] = useState(emptyIntake);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [choices, setChoices] = useState<ResumeChoice[]>([]);
  const [loading, setLoading] = useState(false);
  const talent = publicTalent(draft, method, self);
  const steps = ['收录对象', '账号与资料', self ? '公开设置' : '确认资料', '预览完成'];
  function next(event: FormEvent) {
    event.preventDefault(); setError('');
    if (step === 1 && method === 'github' && !normalizeHandle(draft.github)) { setError('请输入有效的 GitHub 用户名或个人主页链接。'); return; }
    if (step === 1 && method === 'manual' && !draft.name.trim()) { setError('请填写用于展示的姓名或昵称。'); return; }
    if (step === 3) { if (!busy) void onAdd(talent); return; }
    setStep(step + 1);
  }
  async function loadResumes(cloud: boolean) {
    setLoading(true); setMessage(''); setChoices([]);
    try {
      let raw = localStorage.getItem(RESUME_STORAGE_KEY);
      if (cloud) {
        const response = await fetch('/api/resumes', { cache: 'no-store', signal: AbortSignal.timeout(15000) });
        if (response.status === 401) { setMessage('请先在「我的简历」登录并保存简历，再回来带入。'); return; }
        if (!response.ok) throw new Error();
        const body = await response.json();
        if (body.data !== null && typeof body.data !== 'string') throw new Error();
        raw = body.data;
      }
      const library = readResumeLibraryFull(raw);
      const entries: ResumeChoice[] = library.resumes.map(r => ({ id: r.id, label: r.name, data: r }));
      if (library.profile) entries.unshift({ id: 'profile', label: library.profile.name || '我的已存资料', data: library.profile });
      setChoices(entries); setMessage(entries.length ? '选择一份资料带入草稿，所有字段默认隐藏。' : '还没有已保存的资料，可以先去「我的简历」创建，也可以直接填写。');
    } catch { setMessage('暂时无法读取资料，可重试或继续手动填写。'); }
    finally { setLoading(false); }
  }
  return <Dialog open onOpenChange={open => { if (!open) onClose(); }}><DialogContent className={styles.intakeDialog}>
    <DialogClose className={styles.close} aria-label="关闭收录"><X size={18} /></DialogClose>
    <div className={styles.intakeEyebrow}>G H F I N D / TALENT</div>
    <DialogTitle className={styles.intakeTitle}>让好的人才，被看见</DialogTitle>
    <DialogDescription>从一个 GitHub 账号开始，只展示你愿意分享的信息。</DialogDescription>
    <ol className={styles.steps} aria-label="收录步骤">{steps.map((label, i) => <li key={label} data-active={step === i} data-done={step > i} aria-current={step === i ? 'step' : undefined}><span>{step > i ? <Check size={13} /> : `0${i + 1}`}</span>{label}</li>)}</ol>
    <form onSubmit={next} className={styles.intakeForm}>
      <div className={styles.intakeBody}>
        {step === 0 && <><h3>这次，想让谁被发现？</h3><p>为自己建立一张名片，或推荐一位你欣赏的开发者。</p><div className={styles.choiceGrid}>{[{ value: true, title: '收录我自己', body: '关联我的简历，自由选择公开内容', icon: UserRound }, { value: false, title: '推荐其他人', body: '用 GitHub 账号推荐一位开发者', icon: Users }].map(({ value, title, body, icon: Icon }) => <button type="button" key={title} className={styles.choice} aria-pressed={self === value} onClick={() => { if (self !== value) { setSelf(value); setDraft(emptyIntake()); setChoices([]); setMessage(''); } }}><Icon size={23} /><strong>{title}</strong><small>{body}</small><span>{self === value && <Check size={12} />}</span></button>)}</div><div className={styles.privacyNote}><LockKeyhole size={16} /><span>姓名可用昵称。电话、学历、学校、工作经历均非必填。</span></div></>}
        {step === 1 && <><h3>{self ? '你的开发者身份' : '推荐一位开发者'}</h3><div className={styles.methodSwitch}><button type="button" aria-pressed={method === 'github'} onClick={() => { setMethod('github'); setError(''); }}><GitFork size={15} /> 有 GitHub 账号</button><button type="button" aria-pressed={method === 'manual'} onClick={() => { setMethod('manual'); setError(''); }}>没有 GitHub，手动填写</button></div>
          {method === 'github' ? <><label>GitHub 用户名或主页链接<input autoFocus autoComplete="off" value={draft.github} onChange={e => setDraft({ ...draft, github: e.target.value })} placeholder="octocat 或 https://github.com/octocat" maxLength={100} /></label><div className={styles.githubHint}><GitFork size={24} /><div><strong>一个账号就够了</strong><p>接入后从公开项目、技术栈和贡献记录建立档案，无需填写完整简历。</p><small>暂不校验账号存在性、不抓取 GitHub 数据，资料将在审核接入后同步。</small></div></div></> : <><label>展示姓名 / 昵称 <span>必填</span><input autoFocus value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value })} maxLength={40} placeholder="可以使用昵称，不需要真实姓名" /></label>{(['role', 'bio'] as const).map(key => <label key={key}>{key === 'role' ? '技术 / 职业方向' : '个人介绍'} <span>选填</span><input value={draft.fields[key]} onChange={e => setDraft({ ...draft, fields: { ...draft.fields, [key]: e.target.value }, visible: { ...draft.visible, [key]: true } })} maxLength={300} placeholder={key === 'role' ? '例如：前端开发者' : '做过什么，正在探索什么？'} /></label>)}{!self && <label>推荐语 <span>选填 · 将展示在档案中</span><textarea value={draft.recommendation} onChange={e => setDraft({ ...draft, recommendation: e.target.value })} maxLength={500} placeholder="哪些作品或技术实践让你想推荐这位开发者？" /></label>}</>}
        </>}
        {step === 2 && (self ? <><h3>你的资料，由你决定公开多少</h3><p>可以只留微信或邮箱。取消勾选的字段不会加入人才档案，简历原件不受影响。</p><div className={styles.resumeImport}><FileUser size={20} /><div><strong>从「我的简历」带入</strong><p>仅填入当前草稿，不自动公开，不回写简历。</p><div><button type="button" disabled={loading} onClick={() => void loadResumes(false)}>读取本地资料</button><button type="button" disabled={loading} onClick={() => void loadResumes(true)}>读取云端简历</button><Link href="/resume" target="_blank">打开我的简历 ↗</Link></div></div></div>{loading && <p role="status">正在读取…</p>}{message && <p role="status">{message}</p>}{choices.length > 0 && <label>选择资料<select defaultValue="" onChange={e => { const choice = choices.find(c => c.id === e.target.value); if (choice) { setDraft(importResume(draft, choice.data)); setMessage(`已带入「${choice.label}」，请逐项选择公开内容。`); } }}><option value="" disabled>选择一份简历 / 已存资料</option>{choices.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}</select></label>}
          {method === 'github' && <label>展示昵称 <span>选填，默认使用 GitHub 用户名</span><input value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value })} maxLength={40} placeholder="不用公开真实姓名" /></label>}
          <div className={styles.fieldHeading}><span>选填资料</span><span>在人才库公开</span></div>
          {profileFields.filter(([key]) => ['email', 'wechat'].includes(key)).map(([key, label]) => <div className={styles.privacyField} key={key}><label>{label}{['bio', 'experience'].includes(key) ? <textarea maxLength={20000} value={draft.fields[key]} onChange={e => setDraft({ ...draft, fields: { ...draft.fields, [key]: e.target.value } })} placeholder="选填，不公开可留空" /> : <input type={key === 'email' ? 'email' : 'text'} maxLength={20000} value={draft.fields[key]} onChange={e => setDraft({ ...draft, fields: { ...draft.fields, [key]: e.target.value } })} placeholder="选填" />}</label><label className={styles.visibility}><input type="checkbox" checked={!!draft.visible[key]} onChange={e => setDraft({ ...draft, visible: { ...draft.visible, [key]: e.target.checked } })} aria-label={`公开${label}`} />{draft.visible[key] ? '公开' : '隐藏'}</label></div>)}
          <details className={styles.optionalDetails}><summary>补充更多资料 <span>职业介绍、电话、学历、学校、工作经历 · 选填</span></summary>{profileFields.filter(([key]) => !['email', 'wechat'].includes(key)).map(([key, label]) => <div className={styles.privacyField} key={key}><label>{label}{['bio', 'experience'].includes(key) ? <textarea maxLength={20000} value={draft.fields[key]} onChange={e => setDraft({ ...draft, fields: { ...draft.fields, [key]: e.target.value } })} placeholder="选填，不公开可留空" /> : <input type={key === 'email' ? 'email' : 'text'} maxLength={20000} value={draft.fields[key]} onChange={e => setDraft({ ...draft, fields: { ...draft.fields, [key]: e.target.value } })} placeholder="选填" />}</label><label className={styles.visibility}><input type="checkbox" checked={!!draft.visible[key]} onChange={e => setDraft({ ...draft, visible: { ...draft.visible, [key]: e.target.checked } })} aria-label={`公开${label}`} />{draft.visible[key] ? '公开' : '隐藏'}</label></div>)}</details>
        </> : <><h3>只推荐作品，不代替他人公开隐私</h3><p>本次收录 {method === 'github' ? `@${normalizeHandle(draft.github)}` : draft.name}。不要求对方的电话、学校、学历或工作经历，也不会读取你的简历。</p><div className={styles.privacyNote}><LockKeyhole size={18} /><span>联系方式及私人简历资料，后续由本人认领档案后自行补充。</span></div></>)}
        {step === 3 && <><h3>这就是别人能看到的档案</h3><p>只有下方内容会带入人才库。隐藏字段不会附加到档案数据中。</p><div className={styles.publicPreview}><span className={`${styles.avatar} ${styles.sage}`}>{talent.initials}</span><div><strong>{talent.name}</strong><small>{talent.handle ? `@${talent.handle} · GitHub 资料待接入` : '手动收录'}</small></div></div><dl className={styles.publicFields}>{profileFields.filter(([key]) => talent.publicFields?.[key]).map(([key, label]) => <div key={key}><dt>{label}</dt><dd>{talent.publicFields?.[key]}</dd></div>)}</dl>{!Object.keys(talent.publicFields ?? {}).length && <div className={styles.privacyNote}><LockKeyhole size={16} /> 仅展示{method === 'github' ? ' GitHub 用户名' : '昵称'}，未公开其他个人资料。</div>}{draft.recommendation.trim() && <p>推荐语：{talent.note}</p>}<p className={styles.prototypeNote}>提交后进入审核，通过前不会公开展示；收录自己的账号后续需要本人验证。</p></>}
      </div>
      {error && <p role="alert" className={styles.intakeError}>{error}</p>}
      <div className={styles.intakeFooter}><button type="button" className={styles.secondary} onClick={() => { setError(''); if (step) setStep(step - 1); else onClose(); }}><ArrowLeft size={14} />{step ? '上一步' : '取消'}</button><span>{step === 3 ? '仅提交你勾选公开的内容' : step === 2 && self ? '全部选填，可直接继续' : '隐藏字段不会提交'}</span><button className={styles.primary} type="submit" disabled={busy}>{step === 3 ? (busy ? '提交中…' : '确认提交收录') : '下一步'}<ArrowRight size={14} /></button></div>
    </form>
  </DialogContent></Dialog>;
}

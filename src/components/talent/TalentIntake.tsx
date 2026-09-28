'use client';

import { useState, type FormEvent } from 'react';
import { useTranslations } from 'next-intl';
import { ArrowLeft, ArrowRight, Check, FileUser, GitFork, LockKeyhole, UserRound, Users, X } from 'lucide-react';
import { Link } from '@/i18n/navigation';
import { readResumeLibraryFull, RESUME_STORAGE_KEY, type Profile, type Resume } from '@/lib/resume';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { emptyIntake, importResume, normalizeHandle, profileFields, publicTalent } from './intake';
import type { Talent } from './data';
import styles from './talent.module.css';

type ResumeChoice = { id: string; label: string; data: Resume | Profile };
export function TalentIntake({ busy, onClose, onAdd }: { busy: boolean; onClose: () => void; onAdd: (talent: Talent) => void | Promise<void> }) {
  const t = useTranslations('talent');
  const [step, setStep] = useState(0);
  const [self, setSelf] = useState(true);
  const [method, setMethod] = useState<'github' | 'manual'>('github');
  const [draft, setDraft] = useState(emptyIntake);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [choices, setChoices] = useState<ResumeChoice[]>([]);
  const [loading, setLoading] = useState(false);
  const talent = publicTalent(draft, method, self);
  const steps = [t('intake.stepSubject'), t('intake.stepAccount'), self ? t('intake.stepPrivacy') : t('intake.stepConfirm'), t('intake.stepPreview')];
  function next(event: FormEvent) {
    event.preventDefault(); setError('');
    if (step === 1 && method === 'github' && !normalizeHandle(draft.github)) { setError(t('intake.errorGithub')); return; }
    if (step === 1 && method === 'manual' && !draft.name.trim()) { setError(t('intake.errorName')); return; }
    if (step === 3) { if (!busy) void onAdd(talent); return; }
    setStep(step + 1);
  }
  async function loadResumes(cloud: boolean) {
    setLoading(true); setMessage(''); setChoices([]);
    try {
      let raw = localStorage.getItem(RESUME_STORAGE_KEY);
      if (cloud) {
        const response = await fetch('/api/resumes', { cache: 'no-store', signal: AbortSignal.timeout(15000) });
        if (response.status === 401) { setMessage(t('intake.resumeLoginRequired')); return; }
        if (!response.ok) throw new Error();
        const body = await response.json();
        if (body.data !== null && typeof body.data !== 'string') throw new Error();
        raw = body.data;
      }
      const library = readResumeLibraryFull(raw);
      const entries: ResumeChoice[] = library.resumes.map(r => ({ id: r.id, label: r.name, data: r }));
      if (library.profile) entries.unshift({ id: 'profile', label: library.profile.name || t('intake.resumeProfileFallback'), data: library.profile });
      setChoices(entries); setMessage(entries.length ? t('intake.resumePickHint') : t('intake.resumeEmpty'));
    } catch { setMessage(t('intake.resumeLoadFailed')); }
    finally { setLoading(false); }
  }
  return <Dialog open onOpenChange={open => { if (!open) onClose(); }}><DialogContent className={styles.intakeDialog}>
    <DialogClose className={styles.close} aria-label={t('intake.close')}><X size={18} /></DialogClose>
    <div className={styles.intakeEyebrow}>{t('intake.eyebrow')}</div>
    <DialogTitle className={styles.intakeTitle}>{t('intake.title')}</DialogTitle>
    <DialogDescription>{t('intake.description')}</DialogDescription>
    <ol className={styles.steps} aria-label={t('intake.stepsAria')}>{steps.map((label, i) => <li key={label} data-active={step === i} data-done={step > i} aria-current={step === i ? 'step' : undefined}><span>{step > i ? <Check size={13} /> : `0${i + 1}`}</span>{label}</li>)}</ol>
    <form onSubmit={next} className={styles.intakeForm}>
      <div className={styles.intakeBody}>
        {step === 0 && <><h3>{t('intake.whoTitle')}</h3><p>{t('intake.whoBody')}</p><div className={styles.choiceGrid}>{[{ value: true, title: t('intake.selfTitle'), body: t('intake.selfBody'), icon: UserRound }, { value: false, title: t('intake.otherTitle'), body: t('intake.otherBody'), icon: Users }].map(({ value, title, body, icon: Icon }) => <button type="button" key={title} className={styles.choice} aria-pressed={self === value} onClick={() => { if (self !== value) { setSelf(value); setDraft(emptyIntake()); setChoices([]); setMessage(''); } }}><Icon size={23} /><strong>{title}</strong><small>{body}</small><span>{self === value && <Check size={12} />}</span></button>)}</div><div className={styles.privacyNote}><LockKeyhole size={16} /><span>{t('intake.whoPrivacy')}</span></div></>}
        {step === 1 && <><h3>{self ? t('intake.identitySelf') : t('intake.identityOther')}</h3><div className={styles.methodSwitch}><button type="button" aria-pressed={method === 'github'} onClick={() => { setMethod('github'); setError(''); }}><GitFork size={15} /> {t('intake.methodGithub')}</button><button type="button" aria-pressed={method === 'manual'} onClick={() => { setMethod('manual'); setError(''); }}>{t('intake.methodManual')}</button></div>
          {method === 'github' ? <><label>{t('intake.githubLabel')}<input autoFocus autoComplete="off" value={draft.github} onChange={e => setDraft({ ...draft, github: e.target.value })} placeholder={t('intake.githubPlaceholder')} maxLength={100} /></label><div className={styles.githubHint}><GitFork size={24} /><div><strong>{t('intake.githubHintTitle')}</strong><p>{t('intake.githubHintBody')}</p><small>{t('intake.githubHintNote')}</small></div></div></> : <><label>{t('intake.nameLabel')} <span>{t('intake.requiredTag')}</span><input autoFocus value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value })} maxLength={40} placeholder={t('intake.namePlaceholder')} /></label>{(['role', 'bio'] as const).map(key => <label key={key}>{key === 'role' ? t('intake.roleLabel') : t('intake.bioLabel')} <span>{t('intake.optionalTag')}</span><input value={draft.fields[key]} onChange={e => setDraft({ ...draft, fields: { ...draft.fields, [key]: e.target.value }, visible: { ...draft.visible, [key]: true } })} maxLength={300} placeholder={key === 'role' ? t('intake.rolePlaceholder') : t('intake.bioPlaceholder')} /></label>)}{!self && <label>{t('intake.recommendationLabel')} <span>{t('intake.recommendationTag')}</span><textarea value={draft.recommendation} onChange={e => setDraft({ ...draft, recommendation: e.target.value })} maxLength={500} placeholder={t('intake.recommendationPlaceholder')} /></label>}</>}
        </>}
        {step === 2 && (self ? <><h3>{t('intake.privacyTitle')}</h3><p>{t('intake.privacyBody')}</p><div className={styles.resumeImport}><FileUser size={20} /><div><strong>{t('intake.resumeImportTitle')}</strong><p>{t('intake.resumeImportBody')}</p><div><button type="button" disabled={loading} onClick={() => void loadResumes(false)}>{t('intake.loadLocal')}</button><button type="button" disabled={loading} onClick={() => void loadResumes(true)}>{t('intake.loadCloud')}</button><Link href="/resume" target="_blank">{t('intake.openResume')}</Link></div></div></div>{loading && <p role="status">{t('intake.loading')}</p>}{message && <p role="status">{message}</p>}{choices.length > 0 && <label>{t('intake.chooseResume')}<select defaultValue="" onChange={e => { const choice = choices.find(c => c.id === e.target.value); if (choice) { setDraft(importResume(draft, choice.data)); setMessage(t('intake.resumeImported', { label: choice.label })); } }}><option value="" disabled>{t('intake.chooseResumePlaceholder')}</option>{choices.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}</select></label>}
          {method === 'github' && <label>{t('intake.nicknameLabel')} <span>{t('intake.nicknameTag')}</span><input value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value })} maxLength={40} placeholder={t('intake.nicknamePlaceholder')} /></label>}
          <div className={styles.fieldHeading}><span>{t('intake.fieldHeadingFields')}</span><span>{t('intake.fieldHeadingPublic')}</span></div>
          {profileFields.filter(key => ['email', 'wechat'].includes(key)).map(key => <div className={styles.privacyField} key={key}><label>{t(`fields.${key}`)}{['bio', 'experience'].includes(key) ? <textarea maxLength={20000} value={draft.fields[key]} onChange={e => setDraft({ ...draft, fields: { ...draft.fields, [key]: e.target.value } })} placeholder={t('intake.fieldPlaceholderHidden')} /> : <input type={key === 'email' ? 'email' : 'text'} maxLength={20000} value={draft.fields[key]} onChange={e => setDraft({ ...draft, fields: { ...draft.fields, [key]: e.target.value } })} placeholder={t('intake.fieldPlaceholder')} />}</label><label className={styles.visibility}><input type="checkbox" checked={!!draft.visible[key]} onChange={e => setDraft({ ...draft, visible: { ...draft.visible, [key]: e.target.checked } })} aria-label={t('intake.publicAria', { label: t(`fields.${key}`) })} />{draft.visible[key] ? t('intake.visibleOn') : t('intake.visibleOff')}</label></div>)}
          <details className={styles.optionalDetails}><summary>{t('intake.moreFields')} <span>{t('intake.moreFieldsHint')}</span></summary>{profileFields.filter(key => !['email', 'wechat'].includes(key)).map(key => <div className={styles.privacyField} key={key}><label>{t(`fields.${key}`)}{['bio', 'experience'].includes(key) ? <textarea maxLength={20000} value={draft.fields[key]} onChange={e => setDraft({ ...draft, fields: { ...draft.fields, [key]: e.target.value } })} placeholder={t('intake.fieldPlaceholderHidden')} /> : <input type={key === 'email' ? 'email' : 'text'} maxLength={20000} value={draft.fields[key]} onChange={e => setDraft({ ...draft, fields: { ...draft.fields, [key]: e.target.value } })} placeholder={t('intake.fieldPlaceholder')} />}</label><label className={styles.visibility}><input type="checkbox" checked={!!draft.visible[key]} onChange={e => setDraft({ ...draft, visible: { ...draft.visible, [key]: e.target.checked } })} aria-label={t('intake.publicAria', { label: t(`fields.${key}`) })} />{draft.visible[key] ? t('intake.visibleOn') : t('intake.visibleOff')}</label></div>)}</details>
        </> : <><h3>{t('intake.otherPrivacyTitle')}</h3><p>{t('intake.otherPrivacyBody', { target: method === 'github' ? `@${normalizeHandle(draft.github)}` : draft.name })}</p><div className={styles.privacyNote}><LockKeyhole size={18} /><span>{t('intake.otherPrivacyNote')}</span></div></>)}
        {step === 3 && <><h3>{t('intake.previewTitle')}</h3><p>{t('intake.previewBody')}</p><div className={styles.publicPreview}><span className={`${styles.avatar} ${styles.sage}`}>{talent.initials}</span><div><strong>{talent.name}</strong><small>{talent.handle ? t('intake.previewGithubPending', { handle: talent.handle }) : t('intake.previewManual')}</small></div></div><dl className={styles.publicFields}>{profileFields.filter(key => talent.publicFields?.[key]).map(key => <div key={key}><dt>{t(`fields.${key}`)}</dt><dd>{talent.publicFields?.[key]}</dd></div>)}</dl>{!Object.keys(talent.publicFields ?? {}).length && <div className={styles.privacyNote}><LockKeyhole size={16} /> {method === 'github' ? t('intake.previewOnlyGithub') : t('intake.previewOnlyNickname')}</div>}{draft.recommendation.trim() && <p>{t('intake.recommendationPrefix', { note: talent.note })}</p>}<p className={styles.prototypeNote}>{t('intake.reviewNote')}</p></>}
      </div>
      {error && <p role="alert" className={styles.intakeError}>{error}</p>}
      <div className={styles.intakeFooter}><button type="button" className={styles.secondary} onClick={() => { setError(''); if (step) setStep(step - 1); else onClose(); }}><ArrowLeft size={14} />{step ? t('intake.back') : t('intake.cancel')}</button><span>{step === 3 ? t('intake.footerSubmit') : step === 2 && self ? t('intake.footerOptional') : t('intake.footerHidden')}</span><button className={styles.primary} type="submit" disabled={busy}>{step === 3 ? (busy ? t('intake.submitting') : t('intake.confirmSubmit')) : t('intake.next')}<ArrowRight size={14} /></button></div>
    </form>
  </DialogContent></Dialog>;
}

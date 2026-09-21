import type { Profile, Resume } from '@/lib/resume';
import type { Talent } from './data';

// Keys only — labels live in the `talent.fields.*` messages so every locale
// renders its own translation.
export const profileFields = [
  'role', 'location', 'bio',
  'email', 'wechat', 'phone',
  'education', 'school', 'experience',
] as const;
export type Field = typeof profileFields[number];
export type Intake = { name: string; github: string; recommendation: string; fields: Record<Field, string>; visible: Partial<Record<Field, boolean>> };
export const emptyIntake = (): Intake => ({ name: '', github: '', recommendation: '', fields: { role: '', location: '', bio: '', email: '', wechat: '', phone: '', education: '', school: '', experience: '' }, visible: {} });
export function normalizeHandle(value: string): string | null {
  const handle = value.trim().replace(/^https?:\/\/github\.com\//i, '').replace(/^github\.com\//i, '').replace(/\/$/, '').replace(/^@/, '');
  return /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?$/.test(handle) && !handle.includes('--') ? handle : null;
}
export function importResume(draft: Intake, resume: Resume | Profile): Intake {
  const education = resume.sections.filter(s => s.type === 'education').flatMap(s => s.entries);
  const experience = resume.sections.filter(s => s.type === 'experience').flatMap(s => s.entries);
  // Import into a private draft only. Never auto-enable imported fields or copy a legal name.
  return { ...draft, visible: {}, fields: { ...draft.fields,
    role: resume.basics.role, location: resume.basics.city, bio: resume.basics.summary,
    email: resume.basics.email, phone: resume.basics.phone,
    education: education.map(e => e.title).filter(Boolean).join('\n'),
    school: education.map(e => e.subtitle).filter(Boolean).join('\n'),
    experience: experience.map(e => [e.title, e.subtitle, e.period, e.details].filter(Boolean).join(' · ')).join('\n'),
  } };
}
export function publicTalent(draft: Intake, method: 'github' | 'manual', self: boolean): Talent {
  const fields = Object.fromEntries(profileFields.filter(key => (self || ['role', 'location', 'bio'].includes(key)) && draft.visible[key] && draft.fields[key].trim()).map(key => [key, draft.fields[key].trim()])) as Partial<Record<Field, string>>;
  const handle = method === 'github' ? normalizeHandle(draft.github) ?? '' : '';
  const name = draft.name.trim() || handle;
  return { id: 'intake-preview', name, handle, initials: name.slice(0, 2).toUpperCase(), color: 'sage', role: fields.role || '开发者', location: fields.location || '未公开', direction: '未分类', bio: fields.bio || '从作品出发，认识这位开发者。', skills: [], stars: null, contributions: null, score: null, source: method === 'github' ? 'GitHub（待接入）' : '人工整理', project: '待补充代表项目', projectDescription: method === 'github' ? 'GitHub 资料将在接入后同步' : '尚未补充项目', note: draft.recommendation.trim(), available: false, publicFields: fields, pending: true };
}

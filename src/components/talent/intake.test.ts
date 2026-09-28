import { describe, expect, it } from 'vitest';
import { sampleResume } from '@/lib/resume';
import { emptyIntake, importResume, normalizeHandle, publicTalent } from './intake';

describe('talent intake privacy boundary', () => {
  it('imports into a hidden draft without copying legal names or modifying the résumé', () => {
    const resume = sampleResume('modern', true);
    resume.basics.phone = 'private-phone';
    const original = JSON.stringify(resume);
    const draft = importResume({ ...emptyIntake(), name: 'Public alias', visible: { phone: true } }, resume);
    expect(draft.fields.phone).toBe('private-phone');
    expect(draft.visible).toEqual({});
    expect(draft.name).toBe('Public alias');
    const result = JSON.stringify(publicTalent(draft, 'manual', true));
    expect(result).not.toContain('private-phone');
    expect(result).not.toContain(resume.basics.email);
    expect(result).not.toContain('某大学');
    expect(JSON.stringify(resume)).toBe(original);
  });
  it('can publish email and WeChat alone, stripping every other field from the actual record', () => {
    const draft = importResume(emptyIntake(), sampleResume('modern', true));
    draft.name = 'Alias'; draft.fields.wechat = 'my-wechat'; draft.fields.phone = 'secret';
    draft.visible = { email: true, wechat: true };
    const result = publicTalent(draft, 'manual', true);
    expect(result.publicFields).toEqual({ email: 'hello@example.com', wechat: 'my-wechat' });
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(JSON.stringify(result)).not.toContain('某科技公司');
    draft.visible.email = false;
    expect(JSON.stringify(publicTalent(draft, 'manual', true))).not.toContain('hello@example.com');
  });
  it('never includes someone else’s contact or résumé fields even if toggles are set', () => {
    const draft = emptyIntake(); draft.github = 'octocat';
    draft.fields.email = 'private@example.com'; draft.visible.email = true;
    draft.fields.school = 'private school'; draft.visible.school = true;
    expect(publicTalent(draft, 'github', false).publicFields).toEqual({});
  });
  it('accepts a GitHub username alone and handles the no-GitHub path', () => {
    const draft = emptyIntake(); draft.github = 'https://github.com/octocat/';
    expect(publicTalent(draft, 'github', true).name).toBe('octocat');
    draft.name = 'No GitHub';
    expect(publicTalent(draft, 'manual', true).handle).toBe('');
    expect(normalizeHandle('https://github.com/octocat/repository')).toBeNull();
    expect(normalizeHandle('foo--bar')).toBeNull();
    expect(normalizeHandle('@valid-user')).toBe('valid-user');
  });
});

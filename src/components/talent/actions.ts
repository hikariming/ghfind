'use server';

import { randomUUID } from 'node:crypto';
import { createPendingTalent } from '@/lib/talent-db';
import type { Talent } from './data';

export type IntakeSubmitResult = { ok: true } | { ok: false; message: string };

export async function submitTalentIntake(talent: Talent): Promise<IntakeSubmitResult> {
  try {
    if (!talent || typeof talent.name !== 'string' || !talent.name.trim()) {
      return { ok: false, message: '缺少展示姓名，无法提交。' };
    }
    // The client already strips hidden fields via publicTalent(); the server
    // persists pending-only and never lists it until an operator reviews.
    await createPendingTalent({ ...talent, id: `intake-${randomUUID()}`, pending: true });
    return { ok: true };
  } catch (error) {
    console.error('talent.intake_failed', error);
    return { ok: false, message: '提交失败，请稍后重试。' };
  }
}

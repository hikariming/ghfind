import type { Talent } from './data';
import type { IntakeSubmitResult } from '@/lib/talent-intake';

export type { IntakeSubmitResult };

/** Submit the intake form to POST /api/talent/intake (works on both stacks). */
export async function submitTalentIntake(talent: Talent): Promise<IntakeSubmitResult> {
  try {
    const response = await fetch('/api/talent/intake', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(talent),
    });
    return (await response.json()) as IntakeSubmitResult;
  } catch {
    return { ok: false, message: '提交失败，请稍后重试。' };
  }
}

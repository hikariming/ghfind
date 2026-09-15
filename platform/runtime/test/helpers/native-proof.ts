import assert from 'node:assert/strict';
import { captureNativeProbe, type Dispatch, type Target } from '../../src/router';

export const actorId = (target: Target) =>
  (target === 'api-0' ? '1' : target === 'api-1' ? '2' : '3').repeat(64);

// Unit seam only: this models native state, not an actual workerd Container.
export function nativeDispatch(fetch: Dispatch['fetch']): Dispatch {
  return {
    fetch,
    actorId,
    probe: target => captureNativeProbe(request => fetch(target, request), () => ({ actorId: actorId(target), running: true })),
    stop: async () => assert.fail('no lifecycle mutation'),
  };
}

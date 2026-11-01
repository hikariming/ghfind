import {classify} from "./classify";
import type {Notice,State} from "./engine";
export const DIGEST_MS=60*60_000;
// Customer mail covers observed failures, slow business functions and confirmed
// account-level spend signals. Collection gaps and per-resource optimizations
// remain available to operators without creating another customer incident.
export function userFacing(n:Pick<Notice,"key">):boolean {
  // These are the exact monitor names from wrangler.jsonc and the local E2E
  // runner. Its own runtime failure belongs to the independent ops watchdog.
  if(/^Workers:ghfind-cost-monitor(?:-e2e|-local|-local-e2e)?:errors$/.test(n.key))return false;
  return n.key.startsWith("Service:") || n.key.startsWith("Workers:")&&n.key.endsWith(":errors") || n.key==="account:burn" || n.key==="Billing:account:daily";
}
export function discardInternalMail(state:State):number {
  const before=state.outbox.length;
  for(const n of state.outbox)if(userFacing(n)&&n.kind==="recovery"){
    state.recovered??=[];
    if(!state.recovered.some(r=>r.key===n.key&&r.startedAt===(n.startedAt??0)))state.recovered.push({at:Math.max(0,n.expiresAt-7*86400_000),key:n.key,startedAt:n.startedAt??0,evidence:n.evidence});
  }
  state.outbox=state.outbox.filter(n=>userFacing(n)&&n.kind!=="recovery");
  if(state.collection){
    delete state.collection.acceptedRecipients;
    delete state.collection.notified;
    delete state.collection.lastNotifiedAt;
  }
  return before-state.outbox.length;
}
export const DAILY_DIGEST_HOUR_UTC=1;
export function dailySlot(now:number):number {
  const today=Math.floor(now/86400_000)*86400_000+DAILY_DIGEST_HOUR_UTC*3600_000;
  return now>=today?today:today-86400_000;
}
export function urgent(n:Notice):boolean {
  return userFacing(n) && classify(n).priority<=1 && (n.kind==="open"||n.kind==="escalation");
}
export function selectMail(pending:Notice[],now:number,nextDigest:number):Notice[]{
  return pending.filter(n=>userFacing(n)&&n.kind!=="recovery"&&(urgent(n)||(n.kind==="reminder"&&classify(n).priority<=1)||(classify(n).priority===2&&now>=nextDigest)));
}

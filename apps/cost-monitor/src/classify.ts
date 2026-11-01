import type { Notice } from './engine';
export function classify(n: Pick<Notice, 'key' | 'severity'>): {priority: 0|1|2|3; category: string} {
  if(n.key==='account:burn'||n.key==='Billing:account:daily')return {priority:0,category:'计费'};
  if(n.key.startsWith('Deploy:')||n.key.startsWith('CI:'))return {priority:3,category:'部署'};
  if(n.key.startsWith('Monitor:'))return {priority:n.key.includes('heartbeat')?1:3,category:'监控'};
  const feature=n.key.split(':')[1];
  const category=feature?.startsWith('probe-')?'可用性':({scan:'评分',card:'卡片',roast:'锐评',reroast:'锐评'} as Record<string,string>)[feature]??(feature==='ghfind-api'?'线上API':'Worker');
  return {priority:n.key.startsWith('Service:')&&n.key.endsWith(':errors')&&n.severity>=2?1:2,category};
}

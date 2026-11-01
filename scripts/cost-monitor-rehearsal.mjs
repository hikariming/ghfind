import assert from 'node:assert/strict';
const base=new URL(process.env.COST_MONITOR_URL);
assert.equal(base.hostname.split('.')[0],'ghfind-cost-monitor');
const headers={authorization:`Bearer ${process.env.MONITOR_ADMIN_TOKEN}`};
const health=await fetch(new URL('/health',base),{headers}).then(r=>r.json());
assert.equal(health.heartbeatHealthy,true);assert.equal(health.deliveryHealthy,true);assert.equal(health.probeAccountConfigured,true);
console.log(JSON.stringify({event:'production_health',heartbeatHealthy:health.heartbeatHealthy,collectionHealthy:health.collectionHealthy,deliveryHealthy:health.deliveryHealthy,probeAccountConfigured:health.probeAccountConfigured,nextDaily:health.nextDaily}));
base.hostname=base.hostname.replace('ghfind-cost-monitor.','ghfind-cost-monitor-e2e.');
assert.equal(base.hostname.split('.')[0],'ghfind-cost-monitor-e2e');
async function post(phase){
 const response=await fetch(new URL(`/test/${phase}`,base),{method:'POST',headers,signal:AbortSignal.timeout(120000)});
 assert.equal(response.status,200);return response.json();
}
await post('reset');
const daily=await post('daily');
assert.equal(daily.retry,daily.duplicate);assert.ok(daily.retry>0);assert.match(daily.subject,/\[模拟\]\[日报\] 全部正常/);
console.log(JSON.stringify({event:'simulated_daily',...daily}));
await post('reset');
const billing=await post('billing');
assert.match(billing.subject,/\[模拟\]\[P0\]\[计费\]/);assert.ok(billing.accepted>0);assert.equal(billing.pending,0);
console.log(JSON.stringify({event:'simulated_billing',...billing}));

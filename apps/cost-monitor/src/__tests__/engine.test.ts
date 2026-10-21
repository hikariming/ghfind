import { describe,expect,it } from "vitest";
import { acknowledge,compact,describeEvidence,emptyState,evaluate,MAX_DIAGNOSTIC_METRICS,MAX_METRICS,MAX_STATE_BYTES,recipients,reminderInterval,STATE_TTL_MS,WINDOW_MS,type Frame,type Point,type State } from "../engine";
import { businessPoints } from "../business";
const base=1_800_000_000_000;
function frame(i:number,efficiency=200,extra:Partial<Point>={}):Frame {
  return {at:base+i*WINDOW_MS,healthy:["D1","Workers","R2","KV","DO","Queues"],errors:[],points:[{key:"D1:core:read",product:"D1",resource:"core",label:"read",amount:100*efficiency,operations:100,efficiency,unit:"rows",usd:0,efficiencyWarning:50_000,efficiencyCritical:200_000,minAmount:100_000,...extra}]};
}
function run(s:State,i:number,eff=200,extra:Partial<Point>={}){evaluate(s,frame(i,eff,extra),base+i*WINDOW_MS);}
function diagnosticEvidence(s:State,i:number,eff=200,extra:Partial<Point>={}) {
  const f=frame(i,eff,extra),p=f.points[0];
  return describeEvidence(p,s.metrics[p.key],f.at);
}
function worker(s:State,i:number,errors=0,extra:Partial<Point>={}) {
  run(s,i,errors/100,{key:"Workers:bot:errors",product:"Workers",resource:"bot",label:"运行错误",amount:errors,operations:100,unit:"errors",efficiencyWarning:0.02,efficiencyCritical:0.05,minAmount:3,minOperations:20,relative:false,...extra});
}
function ack(s:State,i:number){for(const n of [...s.outbox]){n.delivered=["one@example.org","two@example.org"];acknowledge(s,n,base+i*WINDOW_MS);}}
describe("bounded Cloudflare incident policy",()=>{
  it("explains business failures as affected calls and a percentage",()=>{
    const s=emptyState(),at=base+WINDOW_MS;
    const f=frame(1);f.points=businessPoints([{at,feature:"scan",total:12,failed:3,slow:0}]);evaluate(s,f,at);
    const n=s.outbox.find(n=>n.key==="Service:scan:errors")!;
    expect(n.evidence?.value).toBe("12 次调用中 3 次失败（25%）");
    expect(n.text).toContain("12 次调用中 3 次失败（25%）");
    expect(n.evidence?.impact).toContain("相关用户可能未能获得结果");
    expect(n.text).not.toContain("每次");expect(n.text).not.toContain("不按费用降级");
  });
  it("explains slow business calls using the actual thirty-second threshold",()=>{
    const s=emptyState();
    for(let i=1;i<=2;i++){
      const f=frame(i);f.points=businessPoints([{at:f.at,feature:"scan",total:12,failed:0,slow:3}]);evaluate(s,f,f.at);
    }
    const n=s.outbox.find(n=>n.key==="Service:scan:slow")!;
    expect(n.evidence?.value).toBe("12 次调用中 3 次响应超过 30 秒（25%）");
    expect(n.evidence?.threshold).toContain("20%");
    expect(n.evidence?.impact).toContain("用户可能需要等待更久");
  });
  it("keeps a failed public probe distinct from observed user-call failures",()=>{
    const s=emptyState();
    for(let i=1;i<=2;i++)run(s,i,1,{key:"Service:probe-home:errors",product:"Service",resource:"首页公开访问",label:"公开可用性检查",amount:1,operations:1,unit:"次失败",gauge:true,relative:false,minAmount:1,minOperations:1,efficiencyWarning:1,efficiencyCritical:undefined,observedAt:base+i*WINDOW_MS});
    const n=s.outbox[0];
    expect(n.evidence?.value).toBe("公开检查失败 1 次");
    expect(n.evidence?.impact).toBe("自动检查未收到预期响应；请复查公开页面是否可访问。");
    expect(n.text).not.toContain("次调用中");expect(n.evidence?.value).not.toContain("100%");
  });
  it("explains Worker errors as actual failed runs without inferring which user feature failed",()=>{
    const s=emptyState();worker(s,1,8);const n=s.outbox[0];
    expect(n.evidence?.value).toBe("100 次运行中 8 次失败（8%）");
    expect(n.evidence?.threshold).toContain("5%");
    expect(n.evidence?.threshold).toContain("20");
    expect(n.evidence?.impact).toContain("需结合请求日志确认受影响功能");
  });
  it("reported daily billing describes its actual period and amount without storage/window estimates",()=>{
    const s=emptyState();run(s,1,200,{key:"Billing:account:daily",product:"Billing",resource:"2026-01-01",label:"reported daily cost",amount:12.345,operations:1,efficiency:undefined,gauge:true,unit:"USD/day",usd:0});
    expect(s.outbox[0].text).toContain("已上报日费用：$12.3450");
    expect(s.outbox[0].text).toContain("对应日期：2026-01-01");
    expect(s.outbox[0].text).toContain("每 6 小时重新对账");
    expect(s.outbox[0].text).not.toMatch(/GB-month|本窗口按超额单价/);
  });

  it("supports extensible recipient lists and empty placeholders, rejects invalid lists",()=>{
    expect(recipients('["One@example.org","","two@example.org","one@example.org"]')).toEqual(["one@example.org","two@example.org"]);
    for(const x of ['[]','[null]','["bad"]','["a@x.y\\nBcc: z@x.y"]'])expect(()=>recipients(x)).toThrow();
  });
  it("does not mistake traffic growth for per-query amplification",()=>{
    const s=emptyState();for(let i=1;i<=20;i++)run(s,i);
    run(s,21,200,{amount:20_000_000,operations:100_000});
    expect(s.outbox).toHaveLength(0);
  });
  it("detects the original 380k rows/query regression without sending internal efficiency mail",()=>{
    const s=emptyState();run(s,1,380_000);
    expect(s.metrics['D1:core:read']).toMatchObject({severity:2,trigger:{basis:"absolute"}});
    expect(diagnosticEvidence(s,1,380_000).threshold).toBe("每次操作 ≥ 200000 rows");
    expect(s.outbox).toEqual([]);
  });
  it("retains precise evidence for an internal relative regression below its absolute threshold",()=>{
    const s=emptyState();for(let i=1;i<=14;i++)run(s,i,1000,{operations:1000,amount:1_000_000,usd:0.001});
    const extra={operations:1000,amount:45_000_000,usd:0.045};run(s,15,45_000,extra);
    expect(s.metrics['D1:core:read']).toMatchObject({severity:2,trigger:{basis:"relative"}});
    const evidence=diagnosticEvidence(s,15,45_000,extra);
    expect(evidence.threshold).toContain("相对健康基线 ≥ 10 倍");
    expect(evidence.threshold).toContain("$0.5/h");
    expect(evidence.value).toContain("45.00 倍，$0.54/h");
    expect(evidence.threshold).not.toContain("200000");
    expect(s.outbox).toEqual([]);
  });
  it("does not label the same 45x ratio critical when its cost only meets the warning floor",()=>{
    const s=emptyState();for(let i=1;i<=14;i++)run(s,i,1000,{operations:100,amount:100_000,usd:0.0001});
    const extra={operations:100,amount:4_500_000,usd:0.0045};
    run(s,15,45_000,extra);expect(s.metrics['D1:core:read'].severity).toBe(0);
    run(s,16,45_000,extra);expect(s.metrics['D1:core:read'].severity).toBe(1);
    const evidence=diagnosticEvidence(s,16,45_000,extra);
    expect(evidence.threshold).toContain("相对健康基线 ≥ 3 倍");
    expect(evidence.threshold).toContain("$0.05/h");expect(evidence.threshold).not.toContain("$0.5/h");
    expect(s.outbox).toEqual([]);
  });
  it("separates latched historical severity from a currently weaker condition and clears it on recovery",()=>{
    const s=emptyState();for(let i=1;i<=14;i++)run(s,i,1000,{operations:1000,amount:1_000_000,usd:0.001});
    run(s,15,45_000,{operations:1000,amount:45_000_000,usd:0.045});
    const trigger=structuredClone(s.metrics['D1:core:read'].trigger),weaker={operations:100,amount:6_000_000,usd:0.006};
    run(s,16,60_000,weaker);
    expect(s.metrics['D1:core:read'].severity).toBe(2);expect(s.metrics['D1:core:read'].trigger).toEqual(trigger);
    const evidence=diagnosticEvidence(s,16,60_000,weaker);
    expect(evidence.threshold).toContain("历史严重触发");expect(evidence.threshold).toContain("45.00 倍");
    expect(evidence.impact).toContain("当前仅满足普通条件：每次操作 ≥ 50000 rows");
    expect(evidence.threshold).not.toContain("200000");
    const low={operations:100,amount:100_000,usd:0.0001};run(s,17,1000,low);
    expect(diagnosticEvidence(s,17,1000,low).impact).toContain("当前未再次确认原告警级别");
    run(s,18,1000,low);
    expect(s.metrics['D1:core:read'].trigger).toBeUndefined();
    expect(diagnosticEvidence(s,18,1000,low).threshold).toBe("已连续两个有效窗口恢复正常");
    expect(s.outbox).toEqual([]);
  });
  it("does not invent an absolute trigger for a latched incident migrated without original evidence",()=>{
    const s=emptyState();run(s,1,380_000);delete s.metrics['D1:core:read'].trigger;
    run(s,2,200);
    expect(diagnosticEvidence(s,2).threshold).toContain("旧状态未保存原始触发依据");
    expect(diagnosticEvidence(s,2).threshold).not.toContain("200000");
  });
  it("requires consecutive closed windows for a warning, ignores duplicate/replayed windows",()=>{
    const s=emptyState();worker(s,1,3);worker(s,1,3);expect(s.outbox).toHaveLength(0);
    worker(s,2,3);expect(s.outbox[0].severity).toBe(1);
    const snapshot=JSON.stringify(s);worker(s,1,8);expect(JSON.stringify(s)).toBe(snapshot);
  });
  it("a telemetry gap does not manufacture consecutive warning windows",()=>{
    const s=emptyState();run(s,1,60_000);run(s,3,60_000);
    expect(s.metrics['D1:core:read'].severity).toBe(0);expect(s.metrics['D1:core:read'].bad).toBe(1);
    expect(s.outbox).toHaveLength(0);
  });
  it("a corrected partial window fills missing sources without training healthy metrics twice",()=>{
    const s=emptyState();const partial=frame(1);partial.healthy=["D1"];partial.errors=["Workers unavailable"];evaluate(s,partial,base+WINDOW_MS);
    const seen=s.metrics['D1:core:read'].good;evaluate(s,frame(1),base+WINDOW_MS+1);
    expect(s.metrics['D1:core:read'].good).toBe(seen);expect(s.lastError).toBeNull();expect(s.lastSuccess).toBe(base+WINDOW_MS+1);
  });
  it("a per-source collection gap does not count as consecutive breaches",()=>{
    const s=emptyState();run(s,1,60_000);evaluate(s,{at:base+2*WINDOW_MS,healthy:["Workers"],points:[],errors:["D1 unavailable"]},base+2*WINDOW_MS);
    run(s,3,60_000);expect(s.metrics['D1:core:read'].severity).toBe(0);expect(s.metrics['D1:core:read'].bad).toBe(1);expect(s.outbox).toHaveLength(0);
  });
  it("freezes a healthy baseline throughout an incident",()=>{
    const s=emptyState();for(let i=1;i<=20;i++)run(s,i);const before=s.metrics['D1:core:read'].baseline;
    for(let i=21;i<=40;i++)run(s,i,380_000);
    expect(s.metrics['D1:core:read'].baseline).toBe(before);
  });
  it("reminds P2 at 24 hours, escalates immediately, recovers only after two valid windows",()=>{
    const s=emptyState();worker(s,1,3);worker(s,2,3);ack(s,2);
    worker(s,3,8);expect(s.outbox[0].kind).toBe("escalation");ack(s,3);
    worker(s,8,8);expect(s.outbox).toHaveLength(0);
    worker(s,74,8);expect(s.outbox).toHaveLength(0);
    worker(s,291,8);expect(s.outbox[0].kind).toBe("reminder");ack(s,291);
    worker(s,292);expect(s.outbox).toHaveLength(0);
    worker(s,293);expect(s.outbox).toEqual([]);expect(s.recovered).toHaveLength(1);
    expect(reminderInterval("Billing:account:daily")).toBe(24*3600_000);
  });
  it("drops a partially delivered open after recovery instead of notifying remaining recipients of a stale fault",()=>{
    const s=emptyState();worker(s,1,8);
    s.outbox[0].delivered=["one@example.org"];s.outbox[0].attempts=2;
    worker(s,2);expect(s.outbox).toHaveLength(1);
    worker(s,3);expect(s.metrics['Workers:bot:errors'].severity).toBe(0);expect(s.outbox).toEqual([]);
    worker(s,4,8);expect(s.outbox[0]).toMatchObject({kind:"open",delivered:[]});
  });
  it("replaces a pending reminder or escalation with current recovery evidence",()=>{
    for(const kind of ["reminder","escalation"] as const){
      const s=emptyState();worker(s,1,3);worker(s,2,3);ack(s,2);
      const start=kind==="reminder"?290:3;
      worker(s,start,kind==="reminder"?3:8);
      expect(s.outbox[0].kind).toBe(kind);s.outbox[0].delivered=["one@example.org"];
      worker(s,start+1);worker(s,start+2);
      expect(s.outbox).toEqual([]);expect(s.recovered).toHaveLength(1);
    }
  });
  it("silently closes recovered service failures even when only one recipient received the open",()=>{
    const s=emptyState(),extra={key:"Service:scan:errors",product:"Service" as const,gauge:true,relative:false,minAmount:1,efficiencyWarning:undefined,efficiencyCritical:0};
    run(s,1,1,extra);expect(s.outbox[0].severity).toBe(2);s.outbox[0].delivered=["one@example.org"];
    run(s,2,0,extra);run(s,3,0,extra);
    expect(s.outbox).toEqual([]);expect(s.metrics[extra.key].notifiedSeverity).toBe(0);
  });
  it("keeps an incident active when its source fails or diagnostics are incomplete",()=>{
    const s=emptyState();run(s,1,380_000);ack(s,1);
    for(let i=2;i<=3;i++)evaluate(s,{at:base+i*WINDOW_MS,healthy:["Workers","R2","KV"],points:[],errors:["D1 unavailable"]},base+i*WINDOW_MS);
    expect(s.metrics['D1:core:read'].severity).toBe(2);expect(s.outbox).toHaveLength(0);
    run(s,4,380_000,{key:"D1:core:sql-fingerprint",diagnostic:true});
    run(s,5,380_000,{key:"D1:core:sql-fingerprint",diagnostic:true});ack(s,5);
    for(let i=6;i<=7;i++)evaluate(s,{at:base+i*WINDOW_MS,healthy:["D1"],points:[],errors:[],completeQueries:false},base+i*WINDOW_MS);
    expect(s.metrics['D1:core:sql-fingerprint'].severity).toBe(2);
  });
  it("does not turn a missing storage snapshot into zero storage",()=>{
    const s=emptyState();run(s,1,380_000,{gauge:true});ack(s,1);
    for(let i=2;i<=3;i++)evaluate(s,{at:base+i*WINDOW_MS,healthy:["D1"],points:[],errors:[]},base+i*WINDOW_MS);
    expect(s.metrics['D1:core:read'].severity).toBe(2);
  });
  it("does not double count SQL diagnostic cost or declare account burn recovered on partial data",()=>{
    const s=emptyState();const f=frame(1,380_000,{usd:1,diagnostic:true});evaluate(s,f,base+WINDOW_MS);
    expect(s.metrics['account:burn'].severity).toBe(0);
    const total=frame(2,200,{usd:2});evaluate(s,total,base+2*WINDOW_MS);expect(s.metrics['account:burn'].severity).toBe(2);ack(s,2);
    for(let i=3;i<=4;i++)evaluate(s,{...frame(i),healthy:["D1"]},base+i*WINDOW_MS);
    expect(s.metrics['account:burn'].severity).toBe(2);
  });
  it("rejects a five-minute spike but confirms sustained critical burn after fifteen minutes",()=>{
    const s=emptyState();
    for(let i=1;i<=12;i++)run(s,i);
    run(s,13,200,{usd:0.2});
    expect(s.metrics['account:burn'].severity).toBe(0);
    expect(s.outbox).toEqual([]);
    run(s,14);run(s,15);
    for(let i=16;i<=18;i++)run(s,i,200,{usd:0.2});
    const notice=s.outbox.find(n=>n.key==='account:burn');
    expect(notice).toMatchObject({severity:2,kind:"open"});
    expect(notice?.evidence?.value).toContain("15 分钟 $2.40/h");
    expect(s.metrics['account:burn'].burnWindows).toHaveLength(12);
  });
  it("detects intermittent sustained cost with weighted fifteen-minute and one-hour windows",()=>{
    const s=emptyState();
    for(let i=1;i<=11;i++){run(s,i,200,{usd:i%2 ? 0.1 : 0});expect(s.outbox).toEqual([]);}
    run(s,12,200,{usd:0.05});
    expect(s.outbox.find(n=>n.key==='account:burn')).toMatchObject({severity:1});
  });
  it("never fills unknown cost windows with zero or counts duplicate corrections twice",()=>{
    const s=emptyState();run(s,1,200,{usd:0.2});run(s,1,200,{usd:0.2});
    expect(s.metrics['account:burn'].burnWindows).toHaveLength(1);
    evaluate(s,{...frame(2,200,{usd:0.2}),healthy:["D1"],errors:["Workers unavailable"]},base+2*WINDOW_MS);
    run(s,3,200,{usd:0.2});expect(s.outbox).toEqual([]);
    run(s,4,200,{usd:0.2});expect(s.outbox).toEqual([]);
    run(s,5,200,{usd:0.2});expect(s.outbox.find(n=>n.key==='account:burn')?.severity).toBe(2);
    ack(s,5);
    run(s,8,200,{usd:0.2});run(s,9,200,{usd:0.2});
    expect(s.metrics['account:burn'].severity).toBe(2);
    expect(s.outbox).toEqual([]);
  });
  it("recovers an active burn after two observed low windows without waiting for the long average",()=>{
    const s=emptyState();run(s,1,200,{usd:2});ack(s,1);
    run(s,2);expect(s.outbox).toEqual([]);
    run(s,3);expect(s.recovered?.some(n=>n.key==='account:burn')).toBe(true);
  });
  it("does not let optional diagnostic failure or billing unavailability invalidate covered core costs",()=>{
    const s=emptyState();evaluate(s,{...frame(1,200,{usd:2}),costComplete:true,errors:["Billing unavailable"],diagnostics:["SQL unavailable"]},base+WINDOW_MS);
    expect(s.metrics['account:burn'].severity).toBe(2);
    const other=emptyState();evaluate(other,{...frame(1,200,{usd:2}),costComplete:false,errors:["R2 storage unavailable"]},base+WINDOW_MS);
    expect(other.metrics['account:burn'].severity).toBe(2);expect(other.metrics['account:burn'].burnWindows).toBeUndefined();
    expect(other.outbox[0].evidence?.value).toBe('本 5 分钟已观测至少 $2.00');
  });
  it("turns explicit incomplete cost coverage into a collection gap even when the source omitted an error",()=>{
    const s=emptyState();run(s,1);const lastSuccess=s.lastSuccess;
    const incomplete={...frame(2,200,{usd:0.01}),costComplete:false};evaluate(s,incomplete,base+2*WINDOW_MS);
    expect(incomplete.errors).toEqual(["Monitor: consumption coverage incomplete"]);
    expect(s.lastSuccess).toBe(lastSuccess);expect(s.lastError).toContain("coverage incomplete");
    expect(s.metrics['account:burn'].lastSeen).toBe(base+WINDOW_MS);
  });
  it("alerts on extreme observed partial cost without inventing complete rates or double counting SQL",()=>{
    const s=emptyState();const f={...frame(1,200,{usd:15}),healthy:["D1" as const],costComplete:false,errors:["Workers unavailable"]};
    f.points.push({...f.points[0],key:"D1:core:sql-fingerprint",diagnostic:true,usd:900});evaluate(s,f,f.at);
    const n=s.outbox.find(n=>n.key==="account:burn")!;
    expect(n).toMatchObject({kind:"open",severity:2});
    expect(n.evidence?.value).toBe("本 5 分钟已观测至少 $15.00");
    expect(n.evidence?.threshold).toBe("单个 5 分钟已观测估算消耗 ≥ $2");
    expect(n.evidence?.cost).toContain("部分产品尚未覆盖");
    expect(n.evidence?.cost).toContain("非最终账单");
    expect(n.evidence?.value).not.toMatch(/\/h|15 分钟|1 小时|900/);
    expect(n.text).toContain("本 5 分钟已观测至少 $15.00");
    expect(s.metrics['account:burn'].burnWindows).toBeUndefined();
    expect(s.metrics['account:burn'].samples).toBe(0);expect(s.lastSuccess).toBe(0);
  });
  it("never uses incomplete low-cost observations to recover or fill account history",()=>{
    const s=emptyState();run(s,1,200,{usd:2});ack(s,1);
    const history=structuredClone(s.metrics['account:burn'].burnWindows),lastSuccess=s.lastSuccess;
    for(const [i,usd] of [[2,0],[3,0.01],[4,3]] as const){
      const f={...frame(i,200,{usd}),healthy:["D1" as const],costComplete:false,errors:["Workers unavailable"]};evaluate(s,f,f.at);
      expect(s.metrics['account:burn'].severity).toBe(2);
      expect(s.metrics['account:burn'].burnWindows).toEqual(history);
      expect(s.metrics['account:burn'].good).toBe(0);expect(s.outbox).toEqual([]);
    }
    expect(s.lastSuccess).toBe(lastSuccess);
  });
  it("deduplicates a partial alert and conservatively skips its same-bucket complete correction",()=>{
    const s=emptyState(),f={...frame(1,200,{usd:3}),costComplete:false,errors:["Workers unavailable"]};
    evaluate(s,f,f.at);const id=s.outbox[0].id;evaluate(s,f,f.at+1);
    expect(s.outbox).toHaveLength(1);expect(s.outbox[0].id).toBe(id);ack(s,1);
    run(s,1,200,{usd:4});
    expect(s.metrics['account:burn'].burnWindows).toBeUndefined();expect(s.outbox).toEqual([]);
    run(s,2,200,{usd:0.001});expect(s.metrics['account:burn'].severity).toBe(2);
    run(s,3,200,{usd:0.001});
    expect(s.metrics['account:burn'].burnWindows).toEqual([[base+2*WINDOW_MS,0.001],[base+3*WINDOW_MS,0.001]]);
    expect(s.outbox).toEqual([]);expect(s.recovered?.[0].key).toBe("account:burn");
  });
  it("respects a configured partial-cost threshold and never fills absent history with zero",()=>{
    const s=emptyState(),f={...frame(1,200,{usd:3}),costComplete:false,errors:["Workers unavailable"]};
    evaluate(s,f,f.at,{hourlyWarning:0.5,hourlyCritical:4,dailyWarning:10});
    expect(s.metrics['account:burn']).toBeUndefined();expect(s.outbox).toEqual([]);
    const next={...frame(2,200,{usd:4}),costComplete:false,errors:["Workers unavailable"]};
    evaluate(s,next,next.at,{hourlyWarning:0.5,hourlyCritical:4,dailyWarning:10});
    expect(s.outbox[0].evidence?.value).toBe("本 5 分钟已观测至少 $4.00");
    expect(s.metrics['account:burn'].burnWindows).toBeUndefined();
  });
  it("keeps monitor runtime faults internal while still notifying unrelated Worker failures",()=>{
    const s=emptyState();
    for(const [i,name] of ["ghfind-cost-monitor","ghfind-cost-monitor-e2e","ghfind-cost-monitor-local","ghfind-cost-monitor-local-e2e"].entries()){
      worker(s,i+1,8,{key:`Workers:${name}:errors`,resource:name});
      expect(s.metrics[`Workers:${name}:errors`].severity).toBe(2);
    }
    expect(s.outbox).toEqual([]);
    worker(s,5,8,{key:"Workers:ghfind-cost-monitoring-app:errors",resource:"ghfind-cost-monitoring-app"});
    expect(s.outbox).toHaveLength(1);expect(s.outbox[0].key).toBe("Workers:ghfind-cost-monitoring-app:errors");
  });
  it("does not price a missing known storage snapshot as zero or recover account burn from it",()=>{
    const s=emptyState(),key="R2:bucket:storage:Standard";
    const storage={...frame(1).points[0],key,product:"R2" as const,resource:"bucket",label:"storage",amount:1e9,operations:1,efficiency:undefined,efficiencyWarning:undefined,efficiencyCritical:undefined,gauge:true,usd:2};
    const first=frame(1);first.points.push(storage);evaluate(s,first,base+WINDOW_MS);ack(s,1);
    const windows=structuredClone(s.metrics['account:burn'].burnWindows),lastSuccess=s.lastSuccess,storageExpiry=s.metrics[key].expiresAt;
    for(let i=2;i<=3;i++){
      const missing=frame(i);evaluate(s,missing,base+i*WINDOW_MS);
      expect(missing.costComplete).toBe(false);
      expect(missing.errors).toContain("R2 storage: known snapshot missing; coverage incomplete");
    }
    expect(s.metrics['account:burn'].severity).toBe(2);expect(s.metrics['account:burn'].burnWindows).toEqual(windows);
    expect(s.lastSuccess).toBe(lastSuccess);expect(s.metrics[key].expiresAt).toBe(storageExpiry);expect(s.outbox).toEqual([]);
    for(let i=4;i<=5;i++){
      const complete=frame(i);complete.points.push({...storage,usd:0.01});evaluate(s,complete,base+i*WINDOW_MS);
    }
    expect(s.metrics['account:burn'].severity).toBe(0);expect(s.lastSuccess).toBe(base+5*WINDOW_MS);
  });
  it("expires a disappeared storage gauge at its original TTL so a deleted bucket cannot block coverage forever",()=>{
    const s=emptyState(),key="R2:deleted:storage:Standard";
    run(s,1,200,{key,product:"R2",resource:"deleted",gauge:true,usd:0.01});
    const next=base+WINDOW_MS+STATE_TTL_MS,at=next+WINDOW_MS;
    const f:Frame={at,points:[],healthy:["D1","Workers","R2","KV","DO","Queues"],errors:[]};evaluate(s,f,at);
    expect(s.metrics[key]).toBeUndefined();expect(f.errors).toEqual([]);expect(s.lastSuccess).toBe(at);
  });
  it("applies the cost floor to relative SQL spikes and confirms absolute diagnostics twice",()=>{
    const s=emptyState();const extra={key:"D1:core:sql-fingerprint",diagnostic:true,efficiencyWarning:undefined,efficiencyCritical:undefined,minAmount:1};
    for(let i=1;i<=20;i++)run(s,i,20,{...extra,usd:1e-6});
    run(s,21,2000,{...extra,usd:1e-5});run(s,22,2000,{...extra,usd:1e-5});
    expect(s.metrics[extra.key].severity).toBe(0);expect(s.outbox).toEqual([]);
    const absolute=emptyState();run(absolute,1,380_000,{diagnostic:true});expect(absolute.metrics['D1:core:read'].severity).toBe(0);
    run(absolute,2,380_000,{diagnostic:true});expect(absolute.metrics['D1:core:read'].severity).toBe(2);expect(absolute.outbox).toEqual([]);
  });
  it("bounds cardinality and rejects NaN/duplicate telemetry",()=>{
    const s=emptyState();run(s,1);const existing=s.metrics['D1:core:read'];
    for(let i=0;Object.keys(s.metrics).length<MAX_METRICS;i++)s.metrics[`D1:x:${i}`]={...existing,severity:2};
    for(const m of Object.values(s.metrics))m.severity=2; // every slot is an open incident: nothing may be evicted
    expect(()=>run(s,2,200,{key:"D1:new:read"})).toThrow("cardinality");
    expect(()=>run(emptyState(),1,NaN)).toThrow();
    const f=frame(1);f.points.push({...f.points[0]});expect(()=>evaluate(emptyState(),f,base)).toThrow();
  });
  it("evicts quiet metrics when full instead of failing every collection",()=>{
    // Production: SQL fingerprints and new Workers keep adding keys; every
    // remembered metric also gets a synthetic "stopped" zero point, so the
    // full state used to have no eviction candidate and each tick threw.
    const s=emptyState();run(s,1);const existing=s.metrics['D1:core:read'];
    for(let i=0;Object.keys(s.metrics).length<MAX_METRICS;i++)s.metrics[`D1:x:${i}`]={...existing,lastSeen:base+i};
    expect(()=>run(s,2,200,{key:"D1:new:read"})).not.toThrow();
    expect(s.metrics['D1:new:read']).toBeDefined();
    expect(s.metrics['D1:x:0']).toBeUndefined(); // least recently seen goes first
    expect(Object.keys(s.metrics).length).toBeLessThanOrEqual(MAX_METRICS);
    expect(()=>run(s,3,200,{key:"D1:newer:read"})).not.toThrow();
  });
  it("expires metric state, pending notices and delivery receipts",()=>{
    const s=emptyState();worker(s,1,8);ack(s,1);expect(s.recentDelivery).toHaveLength(1);
    worker(s,289,8);expect(s.outbox).toHaveLength(1);compact(s,base+289*WINDOW_MS+STATE_TTL_MS+1);
    expect(Object.keys(s.metrics)).toHaveLength(0);expect(s.outbox).toHaveLength(0);expect(s.recentDelivery).toHaveLength(0);
  });
  it("migrates 64 old SQL notices so a user-facing Worker incident can use the queue",()=>{
    const s=emptyState();run(s,1,380_000);const existing=s.metrics['D1:core:read'];
    s.metrics={};s.outbox=[];
    for(let i=0;i<MAX_METRICS;i++){
      const key=`D1:core:sql-${i}`;
      s.metrics[key]={...existing,diagnostic:true,lastSeen:base+i};
      if(i<64)s.outbox.push({id:key,key,kind:"open",severity:2,text:"old SQL diagnostic",delivered:i===0?["one@example.org"]:[],attempts:0,expiresAt:base+STATE_TTL_MS});
    }
    expect(()=>worker(s,2,8)).not.toThrow();
    expect(Object.values(s.metrics).filter(m=>m.diagnostic).length).toBeLessThanOrEqual(MAX_DIAGNOSTIC_METRICS);
    expect(s.outbox).toHaveLength(1);expect(s.outbox[0]).toMatchObject({key:"Workers:bot:errors",kind:"open",severity:2});
  });
  it("bounds internal SQL state without creating mail or blocking a Worker incident",()=>{
    const s=emptyState();
    const make=(i:number):Frame=>({...frame(i),completeQueries:true,points:Array.from({length:97},(_,n)=>({...frame(i,380_000).points[0],key:`D1:core:sql-${n}`,diagnostic:true}))});
    evaluate(s,make(1),base+WINDOW_MS);const second=make(2);evaluate(s,second,base+2*WINDOW_MS);
    expect(s.outbox).toEqual([]);expect(Object.values(s.metrics).filter(m=>m.diagnostic&&m.severity===2)).toHaveLength(MAX_DIAGNOSTIC_METRICS);
    expect(second.diagnostics?.join(" ")).toContain("state limited");expect(second.completeQueries).toBe(false);
    expect(()=>worker(s,3,8)).not.toThrow();expect(s.outbox[0]).toMatchObject({key:"Workers:bot:errors",severity:2});
    expect(new TextEncoder().encode(JSON.stringify(s)).byteLength).toBeLessThan(MAX_STATE_BYTES);
  });
  it("evicts an active optional diagnostic when every metric slot is occupied",()=>{
    const s=emptyState();run(s,1,380_000);const existing=s.metrics['D1:core:read'];s.metrics={};s.outbox=[];
    for(let i=0;i<MAX_METRICS;i++)s.metrics[`Workers:busy-${i}:cpu`]={...existing,diagnostic:i===0};
    evaluate(s,{...frame(2,380_000),healthy:[]},base+2*WINDOW_MS);
    expect(s.metrics['Workers:busy-0:cpu']).toBeUndefined();expect(s.metrics['D1:core:read'].severity).toBe(2);
    expect(Object.keys(s.metrics)).toHaveLength(MAX_METRICS);
  });
});

it("uses P0 two-hour, daily-billing 24-hour, P1 six-hour and P2 24-hour reminders",()=>{
 expect(reminderInterval("account:burn",1)).toBe(2*3600_000);
 expect(reminderInterval("Billing:account:daily",1)).toBe(24*3600_000);
 expect(reminderInterval("Service:scan:errors",2)).toBe(6*3600_000);
 expect(reminderInterval("Service:roast:slow",1)).toBe(24*3600_000);
});

it("retains P2 cooldown across recovery and reopen while preserving the new active state",()=>{
 const s=emptyState();worker(s,1,8);ack(s,1);worker(s,2);worker(s,3);
 worker(s,4,8);expect(s.metrics['Workers:bot:errors'].severity).toBe(2);expect(s.outbox).toEqual([]);
 expect(s.recovered).toHaveLength(1);
 worker(s,289,8);expect(s.outbox).toHaveLength(1);
});

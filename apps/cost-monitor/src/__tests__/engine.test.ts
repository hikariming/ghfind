import { describe,expect,it } from "vitest";
import { acknowledge,compact,emptyState,evaluate,MAX_METRICS,recipients,STATE_TTL_MS,WINDOW_MS,type Frame,type Point,type State } from "../engine";
const base=1_800_000_000_000;
function frame(i:number,efficiency=200,extra:Partial<Point>={}):Frame {
  return {at:base+i*WINDOW_MS,healthy:["D1","Workers","R2","KV"],errors:[],points:[{key:"D1:core:read",product:"D1",resource:"core",label:"read",amount:100*efficiency,operations:100,efficiency,unit:"rows",usd:0,efficiencyWarning:50_000,efficiencyCritical:200_000,minAmount:100_000,...extra}]};
}
function run(s:State,i:number,eff=200,extra:Partial<Point>={}){evaluate(s,frame(i,eff,extra),base+i*WINDOW_MS);}
function ack(s:State,i:number){for(const n of [...s.outbox]){n.delivered=["one@example.org","two@example.org"];acknowledge(s,n,base+i*WINDOW_MS);}}
describe("bounded Cloudflare incident policy",()=>{
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
  it("detects the original 380k rows/query regression without waiting for baseline training",()=>{
    const s=emptyState();run(s,1,380_000);
    expect(s.outbox[0]).toMatchObject({kind:"open",severity:2});
  });
  it("requires consecutive closed windows for a warning, ignores duplicate/replayed windows",()=>{
    const s=emptyState();run(s,1,60_000);run(s,1,60_000);expect(s.outbox).toHaveLength(0);
    run(s,2,60_000);expect(s.outbox[0].severity).toBe(1);
    const snapshot=JSON.stringify(s);run(s,1,380_000);expect(JSON.stringify(s)).toBe(snapshot);
  });
  it("a telemetry gap does not manufacture consecutive warning windows",()=>{
    const s=emptyState();run(s,1,60_000);run(s,3,60_000);expect(s.outbox).toHaveLength(0);
  });
  it("a corrected partial window fills missing sources without training healthy metrics twice",()=>{
    const s=emptyState();const partial=frame(1);partial.healthy=["D1"];partial.errors=["Workers unavailable"];evaluate(s,partial,base+WINDOW_MS);
    const seen=s.metrics['D1:core:read'].good;evaluate(s,frame(1),base+WINDOW_MS+1);
    expect(s.metrics['D1:core:read'].good).toBe(seen);expect(s.lastError).toBeNull();expect(s.lastSuccess).toBe(base+WINDOW_MS+1);
  });
  it("a per-source collection gap does not count as consecutive breaches",()=>{
    const s=emptyState();run(s,1,60_000);evaluate(s,{at:base+2*WINDOW_MS,healthy:["Workers"],points:[],errors:["D1 unavailable"]},base+2*WINDOW_MS);
    run(s,3,60_000);expect(s.outbox).toHaveLength(0);
  });
  it("freezes a healthy baseline throughout an incident",()=>{
    const s=emptyState();for(let i=1;i<=20;i++)run(s,i);const before=s.metrics['D1:core:read'].baseline;
    for(let i=21;i<=40;i++)run(s,i,380_000);
    expect(s.metrics['D1:core:read'].baseline).toBe(before);
  });
  it("reminds at 30 minutes, escalates immediately, recovers only after two valid windows",()=>{
    const s=emptyState();run(s,1,60_000);run(s,2,60_000);ack(s,2);
    run(s,3,380_000);expect(s.outbox[0].kind).toBe("escalation");ack(s,3);
    run(s,8,380_000);expect(s.outbox).toHaveLength(0);
    run(s,9,380_000);expect(s.outbox[0].kind).toBe("reminder");ack(s,9);
    run(s,10);expect(s.outbox).toHaveLength(0);
    run(s,11);expect(s.outbox[0].kind).toBe("recovery");
  });
  it("keeps an incident active when its source fails or diagnostics are incomplete",()=>{
    const s=emptyState();run(s,1,380_000);ack(s,1);
    for(let i=2;i<=3;i++)evaluate(s,{at:base+i*WINDOW_MS,healthy:["Workers","R2","KV"],points:[],errors:["D1 unavailable"]},base+i*WINDOW_MS);
    expect(s.metrics['D1:core:read'].severity).toBe(2);expect(s.outbox).toHaveLength(0);
    run(s,4,380_000,{key:"D1:core:sql-fingerprint",diagnostic:true});ack(s,4);
    for(let i=5;i<=6;i++)evaluate(s,{at:base+i*WINDOW_MS,healthy:["D1"],points:[],errors:[],completeQueries:false},base+i*WINDOW_MS);
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
    const total=frame(2,200,{usd:1});evaluate(s,total,base+2*WINDOW_MS);expect(s.metrics['account:burn'].severity).toBe(2);ack(s,2);
    for(let i=3;i<=4;i++)evaluate(s,{...frame(i),healthy:["D1"]},base+i*WINDOW_MS);
    expect(s.metrics['account:burn'].severity).toBe(2);
  });
  it("bounds cardinality and rejects NaN/duplicate telemetry",()=>{
    const s=emptyState();run(s,1);const existing=s.metrics['D1:core:read'];
    for(let i=0;Object.keys(s.metrics).length<MAX_METRICS;i++)s.metrics[`D1:x:${i}`]={...existing,severity:2};
    expect(()=>run(s,2,200,{key:"D1:new:read"})).toThrow("cardinality");
    expect(()=>run(emptyState(),1,NaN)).toThrow();
    const f=frame(1);f.points.push({...f.points[0]});expect(()=>evaluate(emptyState(),f,base)).toThrow();
  });
  it("expires metric state, pending notices and delivery receipts",()=>{
    const s=emptyState();run(s,1,380_000);ack(s,1);compact(s,base+WINDOW_MS+STATE_TTL_MS+1);
    expect(Object.keys(s.metrics)).toHaveLength(0);expect(s.outbox).toHaveLength(0);expect(s.recentDelivery).toHaveLength(0);
  });
});

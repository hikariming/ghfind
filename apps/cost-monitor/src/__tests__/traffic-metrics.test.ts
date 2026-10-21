import {describe,it,expect,vi} from "vitest";
import {collectTraffic,SCAN_COUNT_SQL} from "../traffic-metrics";
const now=Date.parse("2026-10-22T04:00:00Z"),config={account:"a".repeat(32),zone:"b".repeat(32),token:"fake-token"};
function fakeFetch(options:{noRum?:boolean;denied?:boolean;malformed?:boolean;missingDay?:string;retentionDays?:number;zoneDenied?:boolean;settingsUnavailable?:boolean}={}) {
 return vi.fn(async (_:unknown,init?:RequestInit)=>{
  const query=JSON.parse(init!.body as string).query as string;
  if(options.denied || (options.zoneDenied&&query.includes("zones(")))return Response.json({data:null,errors:[{message:"permission denied secret@example.org"}]});
  const rum=query.includes("rumPageload");
  if(query.includes("settings{"))return options.settingsUnavailable?Response.json({errors:[{message:"network"}]}):Response.json({data:{viewer:{[query.includes("accounts(")?"accounts":"zones"]:[{settings:Object.fromEntries(["httpRequests1dGroups","httpRequestsAdaptiveGroups","rumPageloadEventsAdaptiveGroups","workersInvocationsAdaptive"].map(n=>[n,{enabled:true,maxDuration:86400*365,notOlderThan:86400*(options.retentionDays??365)}]))}]}}});
  const rows:Record<string,unknown>={};
  for(const days of [1,3,7])for(const previous of [0,1])rows[`w${days}p${previous}`]=options.noRum&&rum?[]:[{count:100,sum:{requests:100,pageViews:30,bytes:400,visits:50,responseStatusMap:[{edgeResponseStatus:404,requests:10},{edgeResponseStatus:503,requests:2}]},uniq:{uniques:options.malformed?-1:20}}];
  rows.daily=options.noRum&&rum?[]:Array.from({length:14},(_,i)=>({dimensions:{date:`2026-10-${String(8+i).padStart(2,"0")}`},count:100,uniq:{uniques:20},sum:{requests:100,pageViews:30,bytes:400,visits:50,responseStatusMap:[{edgeResponseStatus:404,requests:10},{edgeResponseStatus:503,requests:2}]}})).filter(r=>r.dimensions.date!==options.missingDay);
  for(const days of [1,3,7])for(const previous of [0,1])rows[`tw${days}p${previous}`]=[{count:200}];
  rows.totalDaily=(rows.daily as {dimensions:unknown}[]).map(r=>({...r,count:200}));
  rows.browserDaily=(rows.daily as {dimensions:unknown}[]).map(r=>({...r,count:40}));
  rows.scripts=[{dimensions:{scriptName:"ghfind-api"},sum:{requests:100}}];
  rows.paths=[{count:9,dimensions:{clientRequestPath:"/scan/example-user"}}];rows.countries=[{count:9,dimensions:{clientCountryName:"XX"}}];rows.referrers=[{count:7,dimensions:{refererHost:"example.org"}}];
  return Response.json({data:{viewer:{[query.includes("accounts(")?"accounts":"zones"]:[rows]}}});
 });
}
describe("bounded traffic collection",()=>{
 it("collects all comparisons with host-scoped RUM, filters static paths before top 10",async()=>{
  const fetcher=fakeFetch();const data=await collectTraffic(config,now,fetcher);
  expect(fetcher).toHaveBeenCalledTimes(7);expect(data.end).toBe(Date.parse("2026-10-22T00:00:00Z"));
  expect(data.metrics.find(m=>m.key==="visitors")?.values[0]).toEqual({current:50,previous:50});expect(data.metrics.find(m=>m.key==="4xx")?.values[0].current).toBe(10);expect(data.metrics.find(m=>m.key==="5xx")?.values[0].current).toBe(2);expect(data.paths[0].label).toBe("/scan/example-user");expect(data.referrers[0].label).toBe("example.org");expect(data.days[6].value).toBe(50);expect(data.days[0].value).toBe(50);
  const bodies=fetcher.mock.calls.map(c=>JSON.parse(c[1]!.body as string).query as string);expect(bodies.find(q=>q.includes("rumPageload")&&q.includes("daily:"))).toContain('requestHost:"ghfind.com"');expect(bodies.find(q=>q.includes("paths:"))).toContain('clientRequestPath_notlike:"%.js"');expect(bodies.find(q=>q.includes("httpRequests1dGroups")&&q.includes("daily:"))).toContain('date_geq:"2026-10-08"');
 });
 it("falls back consistently to whole-window unique IPs when RUM absent",async()=>{const d=await collectTraffic(config,now,fakeFetch({noRum:true}));expect(d.visitorSource).toContain("唯一 IP");expect(d.metrics[0].values.every(v=>v.current===20)).toBe(true);});
 it("keeps permission failures and malformed values unavailable, redacts upstream details",async()=>{const d=await collectTraffic(config,now,fakeFetch({denied:true}));expect(d.metrics[0].values[0].current).toBeNull();expect(JSON.stringify(d)).toContain("Zone Analytics 读权限");expect(JSON.stringify(d)).not.toContain("secret@example.org");const invalid=await collectTraffic(config,now,fakeFetch({noRum:true,malformed:true}));expect(invalid.metrics[0].values[0].current).toBeNull();});

 it("keeps current RUM and shorter comparisons when an old day is missing",async()=>{
  const d=await collectTraffic(config,now,fakeFetch({missingDay:"2026-10-08"}));
  expect(d.visitorSource).toContain("RUM");
  expect(d.metrics[0].values[0]).toEqual({current:50,previous:50});
  expect(d.metrics[0].values[2]).toEqual({current:50,previous:null,previousReason:"前期数据不足 1 天"});
 });
 it("rejects partial retention-boundary days even when an aggregate and bucket exist",async()=>{
  const fetcher=fakeFetch({retentionDays:14});const d=await collectTraffic(config,now,fetcher);
  expect(d.metrics[0].values[2].previousReason).toBe("前期数据不足 1 天");
  expect(fetcher.mock.calls.map(c=>JSON.parse(c[1]!.body as string).query).filter(q=>q.includes("daily:")).join()).not.toContain("w7p1:");
 });
 it("never treats unavailable retention metadata as complete coverage",async()=>{
  const d=await collectTraffic(config,now,fakeFetch({settingsUnavailable:true}));expect(d.metrics[0].values.every(v=>v.current===null&&v.previous===null)).toBe(true);
 });
 it("keeps zone permission reasons on metric rows while RUM remains usable",async()=>{
  const d=await collectTraffic(config,now,fakeFetch({zoneDenied:true}));expect(d.metrics[0].values[0].current).toBe(50);
  expect(d.metrics.find(m=>m.key==="bytes")?.values[0].currentReason).toBe("需要 Zone Analytics 读权限");expect(d.unavailable?.paths).toContain("Zone Analytics");
 });
 it("uses the previous UTC midnight for an early manual send and advances at local noon",async()=>{
  const early=await collectTraffic(config,Date.parse("2026-10-21T17:44:00Z"),fakeFetch());expect(early.end).toBe(Date.parse("2026-10-21T00:00:00Z"));
  const noon=await collectTraffic(config,now,fakeFetch());expect(noon.end).toBe(Date.parse("2026-10-22T00:00:00Z"));
 });
 it("partitions edge totals without double counting API and uses Workers only as fallback",async()=>{
  const d=await collectTraffic(config,now,fakeFetch());expect(d.requests?.source).toContain("边缘");expect(d.requests?.days[0]).toMatchObject({total:200,browser:40,api:100,other:60});
  const f=fakeFetch({zoneDenied:true});const fallback=await collectTraffic(config,now,f);expect(fallback.requests?.source).toContain("Workers 调用兜底");expect(fallback.requests?.values[0].current).toBe(100);expect(fallback.requests?.days[0].browser).toBeNull();
  const queries=f.mock.calls.map(c=>JSON.parse(c[1]!.body as string).query).join();expect(queries).toContain("scriptName_in");
 });
 it("uses zone daily totals before Workers when Adaptive is unavailable",async()=>{
  const delegate=fakeFetch();const f:typeof fetch=async(u,i)=>{const q=JSON.parse(i!.body as string).query;return q.includes("httpRequestsAdaptiveGroups(limit:")?Response.json({errors:[{message:"budget depleted"}]}):delegate(u,i);};
  const d=await collectTraffic(config,now,f);expect(d.requests?.source).toContain("zone 日汇总");expect(d.requests?.values[0].current).toBe(100);expect(d.requests?.days[0]).toMatchObject({total:100,browser:null,api:null,other:null});expect(d.requests?.breakdownReason).toContain("本次限流未取到");
 });
 it("preserves totals while refusing inconsistent sampled segments",async()=>{
  const delegate=fakeFetch();const f:typeof fetch=async(u,i)=>{const response=await delegate(u,i),body=await response.json();for(const scope of ["zones","accounts"])for(const rows of body.data?.viewer?.[scope]??[])if(rows.browserDaily)rows.browserDaily=rows.browserDaily.map((r:object)=>({...r,count:200}));return Response.json(body);};
  const d=await collectTraffic(config,now,f);expect(d.requests?.days[0]).toMatchObject({total:200,browser:null,api:null,other:null,reason:"分类数据不足或抽样汇总不一致"});
 });
 it("retries rate limits once, never permissions, and exposes exhaustion",async()=>{
  const delegate=fakeFetch();let calls=0;
  const fetcher:typeof fetch=async(u,i)=>{const q=JSON.parse(i!.body as string).query;if(q.includes("zones(")&&q.includes("settings{")){calls++;return Response.json({errors:[{message:"budget depleted private@example.org"}]});}return delegate(u,i);};
  const d=await collectTraffic(config,now,fetcher);expect(calls).toBe(2);expect(JSON.stringify(d)).toContain("本次限流未取到");expect(JSON.stringify(d)).not.toContain("private@example.org");
 });
 it("queries D1 only after proving the existing covering index",async()=>{
  const bind=vi.fn(()=>({all:async()=>({results:[{detail:"SEARCH public_scan_runs USING COVERING INDEX idx_public_scan_runs_state (state=? AND updated_at>?)"}]})}));
  const db={prepare:vi.fn(()=>({bind})),batch:vi.fn(async()=>Array.from({length:6},()=>({results:[{n:12}]})))} as unknown as D1Database;
  const d=await collectTraffic({...config,db},now,fakeFetch());expect(d.metrics.at(-1)?.key).toBe("scans");expect(db.prepare).toHaveBeenCalledWith(`EXPLAIN QUERY PLAN ${SCAN_COUNT_SQL}`);expect(db.batch).toHaveBeenCalledTimes(1);
 });
 it("never falls back to an unindexed D1 scan",async()=>{const db={prepare:()=>({bind:()=>({all:async()=>({results:[{detail:"SCAN public_scan_runs"}]})})}),batch:vi.fn()} as unknown as D1Database;const d=await collectTraffic({...config,db},now,fakeFetch());expect(db.batch).not.toHaveBeenCalled();expect(d.notes.join()).toContain("D1 索引范围统计");});
});

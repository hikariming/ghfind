import {describe,it,expect,vi} from "vitest";
import {collectTraffic,SCAN_COUNT_SQL} from "../traffic-metrics";
const now=Date.parse("2026-10-22T04:00:00Z"),config={account:"a".repeat(32),zone:"b".repeat(32),token:"fake-token"};
function fakeFetch(options:{noRum?:boolean;denied?:boolean;malformed?:boolean}={}) {
 return vi.fn(async (_:unknown,init?:RequestInit)=>{
  const query=JSON.parse(init!.body as string).query as string;
  if(options.denied)return Response.json({data:null,errors:[{message:"permission denied secret@example.org"}]});
  const rum=query.includes("rumPageload");
  const rows:Record<string,unknown>={};
  for(const days of [1,3,7])for(const previous of [0,1])rows[`w${days}p${previous}`]=options.noRum&&rum?[]:[{count:100,sum:{requests:100,pageViews:30,bytes:400,visits:50,responseStatusMap:[{edgeResponseStatus:404,requests:10},{edgeResponseStatus:503,requests:2}]},uniq:{uniques:options.malformed?-1:20}}];
  rows.daily=[{dimensions:{date:"2026-10-21"},uniq:{uniques:20},sum:{visits:50}}];
  rows.paths=[{count:9,dimensions:{clientRequestPath:"/scan/example-user"}}];rows.countries=[{count:9,dimensions:{clientCountryName:"XX"}}];rows.referrers=[{count:7,dimensions:{refererHost:"example.org"}}];
  return Response.json({data:{viewer:{[rum?"accounts":"zones"]:[rows]}}});
 });
}
describe("bounded traffic collection",()=>{
 it("collects all comparisons with host-scoped RUM, filters static paths before top 10",async()=>{
  const fetcher=fakeFetch();const data=await collectTraffic(config,now,fetcher);
  expect(fetcher).toHaveBeenCalledTimes(4);expect(data.end).toBe(Date.parse("2026-10-22T00:00:00Z"));
  expect(data.metrics.find(m=>m.key==="visitors")?.values[0]).toEqual({current:50,previous:50});expect(data.metrics.find(m=>m.key==="4xx")?.values[0].current).toBe(10);expect(data.metrics.find(m=>m.key==="5xx")?.values[0].current).toBe(2);expect(data.paths[0].label).toBe("/scan/example-user");expect(data.referrers[0].label).toBe("example.org");expect(data.days[6].value).toBe(50);expect(data.days[0].value).toBeNull();
  const bodies=fetcher.mock.calls.map(c=>JSON.parse(c[1]!.body as string).query as string);expect(bodies.find(q=>q.includes("rumPageload"))).toContain('requestHost:"ghfind.com"');expect(bodies.find(q=>q.includes("paths:"))).toContain('clientRequestPath_notlike:"%.js"');expect(bodies.find(q=>q.includes("httpRequests1dGroups"))).toContain('date_geq:"2026-10-08"');
 });
 it("falls back consistently to whole-window unique IPs when RUM absent",async()=>{const d=await collectTraffic(config,now,fakeFetch({noRum:true}));expect(d.visitorSource).toContain("唯一 IP");expect(d.metrics[0].values.every(v=>v.current===20)).toBe(true);});
 it("keeps permission failures and malformed values unavailable, redacts upstream details",async()=>{const d=await collectTraffic(config,now,fakeFetch({denied:true}));expect(d.metrics[0].values[0].current).toBeNull();expect(d.notes.join()).toContain("Zone Analytics:Read");expect(JSON.stringify(d)).not.toContain("secret@example.org");const invalid=await collectTraffic(config,now,fakeFetch({noRum:true,malformed:true}));expect(invalid.metrics[0].values[0].current).toBeNull();});
 it("queries D1 only after proving the existing covering index",async()=>{
  const bind=vi.fn(()=>({all:async()=>({results:[{detail:"SEARCH public_scan_runs USING COVERING INDEX idx_public_scan_runs_state (state=? AND updated_at>?)"}]})}));
  const db={prepare:vi.fn(()=>({bind})),batch:vi.fn(async()=>Array.from({length:6},()=>({results:[{n:12}]})))} as unknown as D1Database;
  const d=await collectTraffic({...config,db},now,fakeFetch());expect(d.metrics.at(-1)?.key).toBe("scans");expect(db.prepare).toHaveBeenCalledWith(`EXPLAIN QUERY PLAN ${SCAN_COUNT_SQL}`);expect(db.batch).toHaveBeenCalledTimes(1);
 });
 it("never falls back to an unindexed D1 scan",async()=>{const db={prepare:()=>({bind:()=>({all:async()=>({results:[{detail:"SCAN public_scan_runs"}]})})}),batch:vi.fn()} as unknown as D1Database;const d=await collectTraffic({...config,db},now,fakeFetch());expect(db.batch).not.toHaveBeenCalled();expect(d.notes.join()).toContain("D1 索引范围统计");});
});

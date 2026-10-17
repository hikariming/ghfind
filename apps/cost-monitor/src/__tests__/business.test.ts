import {describe,it,expect} from "vitest";
import {summarize,businessPoints,probe} from "../business";
import {emptyState,evaluate,acknowledge,WINDOW_MS} from "../engine";
function trace(path:string,status=200,summary?:Record<string,unknown>,extra?:{category?:string;wallTime?:number}):TraceItem {
  const logs=summary?[{message:["roast.summary",JSON.stringify(summary)]}]:extra?.category?[{message:["fresh_scan_failed",{route:"scan",username:"private-user",category:extra.category}]}]:[];
  return {scriptName:"ghfind-api",eventTimestamp:1_800_000_000_000,event:{request:{url:`https://ghfind.com${path}`,method:"GET",headers:{}},response:{status}},logs,exceptions:[],outcome:"ok",wallTime:extra?.wallTime??100} as unknown as TraceItem;
}
describe("critical business telemetry",()=>{
  it("detects failed streaming generation despite HTTP 200 without persisting private logs",()=>{
    const rows=summarize([trace("/api/roast",200,{path:"default",source:"generate",ok:false,requestId:"private",username:"private-user"})]);
    expect(rows[0]).toMatchObject({feature:"roast",failed:1,total:1});expect(JSON.stringify(rows)).not.toContain("private");
    const s=emptyState();evaluate(s,{at:rows[0].at,points:businessPoints(rows),healthy:[],errors:[]},rows[0].at);
    expect(s.outbox[0]).toMatchObject({severity:2});expect(s.outbox[0].text).toContain("首页锐评生成");
  });
  it("covers README cards and ignores user errors, disconnects and BYO failures",()=>{
    expect(summarize([trace("/api/card/mini/alice",500)])[0].failed).toBe(1);
    expect(summarize([trace("/api/roast",400)])).toEqual([]);
    expect(summarize([trace("/api/roast",200,{path:"byo",source:"generate",ok:false})])[0].failed).toBe(0);
  });
  it("ignores Cache API internal hosts so match-miss 504s are not card failures",()=>{
    const item=trace("/api/card/alice",504);
    (item.event as {request:{url:string}}).request.url="https://edge-cache.ghfind.internal/api/card/alice";
    expect(summarize([item])).toEqual([]);
    const named=trace("/api/card/alice",504);
    (named.event as {request:{url:string}}).request.url="https://card-cache.ghfind.internal/api/card/alice";
    expect(summarize([named])).toEqual([]);
    expect(summarize([trace("/api/card/alice",504)])[0].failed).toBe(1);
  });
  it("does not infer recovery from missing traffic; requires two observed healthy windows",()=>{
    const s=emptyState(),at=1_800_000_000_000;
    for(const [i,failed] of [[0,1],[1,null],[2,0],[3,0]] as const){
      evaluate(s,{at:at+i*WINDOW_MS,points:failed===null?[]:businessPoints([{at,feature:"card",total:1,failed,slow:0}]),healthy:[],errors:[]},at+i*WINDOW_MS);
      if(i<3)expect(s.metrics["Service:card:errors"].severity).toBe(2);
    }
    expect(s.metrics["Service:card:errors"].severity).toBe(0);
  });
  it("treats an HTTP 200 HTML challenge on a card URL as unavailable",async()=>{
    const points=await probe(Date.now(),async()=>new Response("challenge",{headers:{"content-type":"text/html"}}));
    expect(points.find(p=>p.resource.includes("炫耀大卡"))?.amount).toBe(1);
  });
  it("suppresses the reported tiny DO relative spike but retains material billing spikes",()=>{
    const s=emptyState(),at=1_800_000_000_000,key="DO:coord:read";
    const frame=(i:number,amount:number,efficiency:number)=>({at:at+i*WINDOW_MS,points:[{key,product:"DO" as const,resource:"coord",label:"读取",amount,efficiency,operations:1722,unit:"rows",usd:amount*1e-9}],healthy:[],errors:[]});
    for(let i=0;i<15;i++)evaluate(s,frame(i,100,.01),at+i*WINDOW_MS);
    evaluate(s,frame(15,426,.247),at+15*WINDOW_MS);expect(s.outbox).toEqual([]);
    evaluate(s,frame(16,100_000_000,1000),at+16*WINDOW_MS);
    expect(s.metrics[key].severity).toBe(2);expect(s.outbox).toEqual([]); // $0.10 remains an optimization signal.
    evaluate(s,frame(17,2_000_000_000,2000),at+17*WINDOW_MS);
    expect(s.outbox[0]).toMatchObject({key:"account:burn",severity:2});
    expect(s.outbox[0].evidence?.value).toBe("本 5 分钟已观测至少 $2.00");
  });
});

it("silently clears recovered business incidents instead of emailing zero failures",()=>{
  const s=emptyState(),at=1_800_000_000_000;
  const run=(i:number,failed:number)=>evaluate(s,{at:at+i*WINDOW_MS,points:businessPoints([{at,feature:"roast",total:1,failed,slow:0}]),healthy:[],errors:[]},at+i*WINDOW_MS);
  run(0,1);acknowledge(s,s.outbox[0],at);run(1,0);run(2,0);
  expect(s.outbox).toEqual([]);expect(s.metrics["Service:roast:errors"].notifiedSeverity).toBe(0);
  run(3,1);expect(s.outbox[0].kind).toBe("open");
});
it("ignores disconnected streaming clients even when their logs report failure",()=>{
  const item=trace("/api/roast",200,{path:"default",source:"generate",ok:false});
  expect(summarize([{...item,outcome:"clientDisconnected"}])).toEqual([]);
});
it("treats scan collect deadlines and scan_busy as degraded, not failures",()=>{
  expect(summarize([trace("/api/scan",503,undefined,{category:"github_collect_deadline"})])[0]).toMatchObject({feature:"scan",failed:0,total:1});
  expect(summarize([trace("/api/scan",503,undefined,{category:"scan_busy"})])[0]).toMatchObject({failed:0});
  expect(summarize([trace("/api/scan",200,undefined,{category:"github_collect_deadline"})])[0]).toMatchObject({failed:0});
  expect(JSON.stringify(summarize([trace("/api/scan",503,undefined,{category:"github_collect_deadline"})]))).not.toContain("private-user");
  expect(summarize([trace("/api/scan",503)])[0]).toMatchObject({failed:1});
});
it("requires a 20% scan failure rate and at least 3 failures before paging",()=>{
  const s=emptyState(),at=1_800_000_000_000;
  evaluate(s,{at,points:businessPoints([{at,feature:"scan",total:10,failed:2,slow:0}]),healthy:[],errors:[]},at);
  expect(s.outbox).toEqual([]);
  evaluate(s,{at:at+WINDOW_MS,points:businessPoints([{at,feature:"scan",total:20,failed:3,slow:0}]),healthy:[],errors:[]},at+WINDOW_MS);
  expect(s.outbox).toEqual([]);
  evaluate(s,{at:at+2*WINDOW_MS,points:businessPoints([{at,feature:"scan",total:10,failed:3,slow:0}]),healthy:[],errors:[]},at+2*WINDOW_MS);
  expect(s.outbox[0]).toMatchObject({severity:2,key:"Service:scan:errors"});
});

import { WINDOW_MS, type Point } from "./engine";
export interface BusinessCount { at:number; feature:"card"|"roast"|"scan"; total:number; failed:number; slow:number }
const SCAN_DEGRADED=new Set(["github_collect_deadline","scan_busy"]);
function scanDegraded(item:TraceItem):boolean {
  for(const log of item.logs){
    const message=log.message;
    if(!Array.isArray(message) || message[0]!=="fresh_scan_failed")continue;
    const payload=message[1];
    let category="";
    if(payload && typeof payload==="object" && !Array.isArray(payload)){
      const value=(payload as {category?:unknown}).category;
      if(typeof value==="string")category=value;
    }else if(typeof payload==="string"){
      try{
        const parsed=JSON.parse(payload) as {category?:unknown};
        if(typeof parsed.category==="string")category=parsed.category;
      }catch{/* Invalid log cannot create a false incident. */}
    }
    if(SCAN_DEGRADED.has(category))return true;
  }
  return false;
}
// Persist only fixed feature counters. Never retain URLs, usernames, log text or tokens.
export function summarize(events:TraceItem[]):BusinessCount[] {
  const counts=new Map<string,BusinessCount>();
  for(const item of events){
    if(item.scriptName!=="ghfind-api" || !item.event || !("request" in item.event) || !item.eventTimestamp)continue;
    let path:string;try{path=new URL(item.event.request.url).pathname;}catch{continue;}
    const feature= /^\/api\/(card|badge|material-card)\//.test(path)?"card":path==="/api/roast"?"roast":path==="/api/scan"?"scan":null;
    if(!feature)continue;
    if(["clientDisconnected","responseStreamDisconnected"].includes(item.outcome))continue;
    const status=item.event.response?.status??0;
    // User validation, Turnstile, rate limits and client disconnects are not server faults.
    let failed=status>=500 || item.exceptions.length>0 || ["exceededCpu","exceededMemory","exception"].includes(item.outcome);
    let slow=item.wallTime>30_000;
    if(feature==="scan" && scanDegraded(item))failed=false;
    if(feature==="roast")for(const log of item.logs){
      const message=log.message;
      if(message[0]!=="roast.summary" || typeof message[1]!=="string")continue;
      try{const row=JSON.parse(message[1]) as Record<string,unknown>;
        // BYO provider configuration is outside the site's managed LLM availability.
        if(row.path!=="byo" && row.source==="generate") {
          if(row.ok===false)failed=true;
          if(typeof row.firstContentMs==="number" && row.firstContentMs>30_000)slow=true;
        }
      }catch{/* Invalid log cannot create a false incident. */}
    }
    if(status>=400&&status<500&&!failed)continue;
    const at=Math.floor(item.eventTimestamp/WINDOW_MS)*WINDOW_MS,key=`${at}:${feature}`;
    const value=counts.get(key)??{at,feature,total:0,failed:0,slow:0};value.total++;value.failed+=Number(failed);value.slow+=Number(slow);counts.set(key,value);
  }
  return [...counts.values()];
}
export function businessPoints(rows:BusinessCount[]):Point[]{
  const names={card:"GitHub README 炫耀卡",roast:"首页锐评生成",scan:"首页 GitHub 分析"};
  return rows.flatMap(r=>[
    {key:`Service:${r.feature}:errors`,product:"Service" as const,resource:names[r.feature],label:"关键功能失败",amount:r.failed,operations:r.total,unit:"次失败",usd:0,gauge:true,relative:false,minAmount:r.feature==="scan"?3:1,minOperations:1,efficiency:r.failed/r.total,efficiencyCritical:r.feature==="scan"?0.2:0,denominator:"已观测功能调用"},
    {key:`Service:${r.feature}:slow`,product:"Service" as const,resource:names[r.feature],label:"响应超过 30 秒",amount:r.slow,operations:r.total,unit:"次慢响应",usd:0,gauge:true,relative:false,minAmount:2,minOperations:1,efficiency:r.slow/r.total,efficiencyWarning:0.2,denominator:"已观测功能调用"},
  ]);
}
export async function probe(now:number,fetcher=fetch):Promise<Point[]>{
  const targets=[{name:"首页公开访问",url:"https://ghfind.com/",type:"text/html"},{name:"README 炫耀大卡公开访问",url:"https://ghfind.com/api/card/torvalds",type:"image/png"},{name:"README 迷你卡公开访问",url:"https://ghfind.com/api/card/mini/torvalds",type:"image/svg+xml"}];
  return Promise.all(targets.map(async t=>{
    let failed=0;
    try{const response=await fetcher(t.url,{signal:AbortSignal.timeout(15_000),redirect:"follow"});
      try{if(!response.ok || !(response.headers.get("content-type")??"").includes(t.type))failed=1;}finally{await response.body?.cancel();}
    }catch{failed=1;}
    return {key:`Service:probe-${t.name}:errors`,product:"Service" as const,resource:t.name,label:"公开可用性检查",observedAt:now,amount:failed,operations:1,unit:"次失败",usd:0,gauge:true,relative:false,minAmount:1,minOperations:1,efficiency:failed,efficiencyWarning:1};
  }));
}

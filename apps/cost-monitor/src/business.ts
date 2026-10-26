import { WINDOW_MS, type Point } from "./engine";
// "roast" is interactive homepage/profile generation (fetch /api/roast).
// "reroast" is the background auto re-roast queue drained by the ghfind-api
// cron (#566): nobody waits on it, so it never feeds roast latency or the
// roast P1, and pages only as a sustained P2 (see businessPoints).
export interface BusinessCount { at:number; feature:"card"|"roast"|"scan"|"reroast"; total:number; failed:number; slow:number }
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
/** Terminal outcome of one background re-roast job from its `auto_reroast` log. */
function reroastOutcome(message:unknown[]):"done"|"failed"|null {
  if(message[0]!=="auto_reroast")return null;
  let payload=message[1];
  if(typeof payload==="string"){try{payload=JSON.parse(payload);}catch{return null;}}
  if(!payload || typeof payload!=="object" || Array.isArray(payload))return null;
  const outcome=(payload as {outcome?:unknown}).outcome;
  // pending/retry/superseded/expired/skipped are queue states, not generation results.
  return outcome==="done"||outcome==="failed"?outcome:null;
}
// Persist only fixed feature counters. Never retain URLs, usernames, log text or tokens.
export function summarize(events:TraceItem[]):BusinessCount[] {
  const counts=new Map<string,BusinessCount>();
  const add=(eventTimestamp:number,feature:BusinessCount["feature"],failed:boolean,slow:boolean)=>{
    const at=Math.floor(eventTimestamp/WINDOW_MS)*WINDOW_MS,key=`${at}:${feature}`;
    const value=counts.get(key)??{at,feature,total:0,failed:0,slow:0};value.total++;value.failed+=Number(failed);value.slow+=Number(slow);counts.set(key,value);
  };
  for(const item of events){
    if(item.scriptName!=="ghfind-api" || !item.event || !item.eventTimestamp)continue;
    if(!("request" in item.event)){
      // Cron invocations: count background re-roast jobs by their worker outcome.
      // Their roast.summary rows and multi-minute wallTime are deliberately not
      // treated as interactive roast calls.
      if("cron" in item.event)for(const log of item.logs){
        const outcome=Array.isArray(log.message)?reroastOutcome(log.message):null;
        if(outcome)add(item.eventTimestamp,"reroast",outcome==="failed",false);
      }
      continue;
    }
    let path:string;let host:string;
    try{const url=new URL(item.event.request.url);path=url.pathname;host=url.hostname;}catch{continue;}
    // Cache API match-miss 504s are keyed on *.ghfind.internal and are not user 5xx.
    if(host==="edge-cache.ghfind.internal"||host.endsWith(".ghfind.internal"))continue;
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
    add(item.eventTimestamp,feature,failed,slow);
  }
  return [...counts.values()];
}
/** Roast generation is a low-volume LLM stream (a handful of calls per five
 * minutes) whose isolated provider failures already degrade to a stored
 * previous-release report. Page on repeated failures within a rolling window
 * instead of on any single failure: one sporadic timeout in a 2-call bucket is
 * not an outage, while a real provider outage fails every generation and
 * reaches two failures within the lookback even at night-time traffic. */
export const ROAST_FAILURE_LOOKBACK_WINDOWS=6;
export const ROAST_FAILURE_MIN_FAILED=2;
/** Sum one feature's counts over the rolling lookback ending at `at` (inclusive). */
export function rollingCounts(rows:BusinessCount[],feature:BusinessCount["feature"],at:number,windows:number):{total:number;failed:number}{
  const from=at-(windows-1)*WINDOW_MS;
  return rows.filter(r=>r.feature===feature&&r.at>=from&&r.at<=at).reduce((sum,r)=>({total:sum.total+r.total,failed:sum.failed+r.failed}),{total:0,failed:0});
}
/** `rows` are the current window's counts; `history` may add earlier windows
 * (the current window included) for features judged over a rolling lookback.
 * Without history, the current window is the whole lookback. */
export function businessPoints(rows:BusinessCount[],history:BusinessCount[]=rows):Point[]{
  const names={card:"GitHub README 炫耀卡",roast:"首页锐评生成",scan:"首页 GitHub 分析",reroast:"后台自动重新锐评"};
  return rows.flatMap(r=>r.feature==="reroast"?[reroastErrorPoint(r,history,names.reroast)]:[
    r.feature==="roast"?roastErrorPoint(r,history,names.roast):
    {key:`Service:${r.feature}:errors`,product:"Service" as const,resource:names[r.feature],label:"关键功能失败",amount:r.failed,operations:r.total,unit:"次失败",usd:0,gauge:true,relative:false,minAmount:r.feature==="scan"?3:1,minOperations:1,efficiency:r.failed/r.total,efficiencyCritical:r.feature==="scan"?0.2:0,denominator:"已观测功能调用"},
    {key:`Service:${r.feature}:slow`,product:"Service" as const,resource:names[r.feature],label:"响应超过 30 秒",amount:r.slow,operations:r.total,unit:"次慢响应",usd:0,gauge:true,relative:false,minAmount:2,minOperations:1,efficiency:r.slow/r.total,efficiencyWarning:0.2,denominator:"已观测功能调用"},
  ]);
}
function roastErrorPoint(current:BusinessCount,history:BusinessCount[],resource:string):Point{
  // The current window is authoritative even if history was read before a
  // late Tail batch landed; earlier windows come from history only.
  const earlier=rollingCounts(history.filter(r=>r.at!==current.at),"roast",current.at,ROAST_FAILURE_LOOKBACK_WINDOWS);
  const total=current.total+earlier.total,failed=current.failed+earlier.failed;
  return {key:"Service:roast:errors",product:"Service",resource,label:"关键功能失败",amount:failed,operations:total,unit:"次失败",usd:0,gauge:true,relative:false,minAmount:ROAST_FAILURE_MIN_FAILED,minOperations:1,efficiency:total?failed/total:0,efficiencyCritical:0,denominator:"已观测功能调用",scope:"近 30 分钟"};
}
/** Background re-roasts retry and keep showing the previous report, so they
 * only warn (P2) on a sustained failure rate over the same rolling lookback:
 * at least 3 failed jobs and half of finished jobs. */
export const REROAST_FAILURE_MIN_FAILED=3;
function reroastErrorPoint(current:BusinessCount,history:BusinessCount[],resource:string):Point{
  const earlier=rollingCounts(history.filter(r=>r.at!==current.at),"reroast",current.at,ROAST_FAILURE_LOOKBACK_WINDOWS);
  const total=current.total+earlier.total,failed=current.failed+earlier.failed;
  return {key:"Service:reroast:errors",product:"Service",resource,label:"后台任务失败",amount:failed,operations:total,unit:"次失败",usd:0,gauge:true,relative:false,minAmount:REROAST_FAILURE_MIN_FAILED,minOperations:1,efficiency:total?failed/total:0,efficiencyWarning:0.5,denominator:"已完成后台任务",scope:"近 30 分钟"};
}
export async function probe(now:number,fetcher=fetch,login?:string):Promise<Point[]>{
  const targets=[{name:"首页公开访问",url:"https://ghfind.com/",type:"text/html"}];
  if(login&&/^[a-zA-Z0-9-]{1,39}$/.test(login))targets.push(
    {name:"README 炫耀大卡公开访问",url:`https://ghfind.com/api/card/${encodeURIComponent(login)}`,type:"image/png"},
    {name:"README 迷你卡公开访问",url:`https://ghfind.com/api/card/mini/${encodeURIComponent(login)}`,type:"image/svg+xml"});
  return Promise.all(targets.map(async t=>{
    let failed=0;
    try{const response=await fetcher(t.url,{signal:AbortSignal.timeout(15_000),redirect:"follow"});
      try{if(!response.ok || !(response.headers.get("content-type")??"").includes(t.type))failed=1;}finally{await response.body?.cancel();}
    }catch{failed=1;}
    return {key:`Service:probe-${t.name}:errors`,product:"Service" as const,resource:t.name,label:"公开可用性检查",observedAt:now,amount:failed,operations:1,unit:"次失败",usd:0,gauge:true,relative:false,minAmount:1,minOperations:1,efficiency:failed,efficiencyWarning:1};
  }));
}

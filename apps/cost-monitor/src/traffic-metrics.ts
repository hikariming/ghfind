import { boundedJson } from "./metrics";
export const DAY = 86400_000;
export interface Comparison { current: number | null; previous: number | null }
export interface TrafficMetric { key:string; label:string; unit?:"bytes"|"percent"; values:Comparison[] }
export interface Ranking { label:string; value:number }
export interface TrafficReport {
  generatedAt:number; end:number; visitorSource:string; metrics:TrafficMetric[];
  days:{date:string; value:number|null}[];
  paths:Ranking[]; countries:Ranking[]; referrers:Ranking[]; notes:string[];
}
export interface TrafficConfig { account:string; token:string; zone?:string; host?:string; db?:D1Database }
type Row = {sum?:Record<string,unknown>; uniq?:{uniques:number}; count?:number; dimensions?:Record<string,string>};
const date=(at:number)=>new Date(at).toISOString().slice(0,10);
const iso=(at:number)=>new Date(at).toISOString();
function numeric(value:unknown):number {if(typeof value!=="number"||!Number.isFinite(value)||value<0)throw new Error("Invalid metric");return value;}
function reason(error:unknown):string {
  const message=error instanceof Error?error.message:"";
  if(/does not have access to the field|not entitled|not supported/i.test(message))return "套餐不支持该字段，需调整 Analytics 套餐或改用可用数据源";
  if(/access|permission|unauthor|forbidden|HTTP 40[13]/i.test(message))return "权限不足：zone 需 Zone Analytics:Read，RUM 需 Account Analytics:Read";
  if(/budget|limit|429/i.test(message))return "Analytics 查询预算或套餐限制，等待下次采集";
  return "数据源不可用或响应不完整";
}
async function query(config:TrafficConfig,scope:"zones"|"accounts",selection:string,fetcher:typeof fetch):Promise<Record<string,Row[]>> {
  if(scope==="zones"&&!/^[a-f0-9]{32}$/i.test(config.zone??""))throw new Error("Zone configuration missing");
  const filter=scope==="zones"?`zoneTag:${JSON.stringify(config.zone)}`:`accountTag:${JSON.stringify(config.account)}`;
  const payload=await boundedJson(await fetcher("https://api.cloudflare.com/client/v4/graphql",{method:"POST",headers:{authorization:`Bearer ${config.token}`,"content-type":"application/json"},body:JSON.stringify({query:`{viewer{${scope}(filter:{${filter}}){${selection}}}}`}),signal:AbortSignal.timeout(20_000)})) as {errors?:{message:string}[];data?:{viewer?:Record<string,Record<string,Row[]>[]>}};
  if(payload.errors?.length)throw new Error(payload.errors.map(e=>e.message).join(" "));
  const rows=payload.data?.viewer?.[scope];
  if(!Array.isArray(rows)||rows.length!==1)throw new Error("Missing metrics");
  return rows[0];
}
const WINDOWS=[1,3,7];
const periods=(end:number)=>WINDOWS.flatMap(days=>[0,1].map(previous=>({name:`w${days}p${previous}`,start:end-days*DAY*(previous+1),end:end-days*DAY*previous})));
function values(rows:Record<string,Row[]>|undefined,read:(row:Row)=>number):Comparison[] {
  const get=(key:string)=>{try{const r=rows?.[key];return r?.length===1?read(r[0]):null;}catch{return null;}};
  return WINDOWS.map(d=>({current:get(`w${d}p0`),previous:get(`w${d}p1`)}));
}
function top(rows:Row[]|undefined,dimension:string):Ranking[] {
  if(!Array.isArray(rows))return [];
  return rows.slice(0,10).map(r=>({label:String(r.dimensions?.[dimension]??"直接访问").slice(0,240)||"直接访问",value:numeric(r.count)}));
}
// The existing covering index bounds the query by state and time. INDEXED BY
// fails closed if a deployment lacks the index; never fall back to a table scan.
export const SCAN_COUNT_SQL="SELECT COUNT(*) AS n FROM public_scan_runs INDEXED BY idx_public_scan_runs_state WHERE state IN ('complete_public','partial_public') AND updated_at >= ? AND updated_at < ?";
export async function collectTraffic(config:TrafficConfig,now=Date.now(),fetcher=fetch):Promise<TrafficReport> {
  // Free-plan hourly retention cannot cover previous 7d. All sources share the
  // latest complete UTC-day cutoff, displayed explicitly as 08:00 UTC+8.
  const end=Math.floor(now/DAY)*DAY;
  const report:TrafficReport={generatedAt:now,end,visitorSource:"Cloudflare 唯一 IP（非独立自然人）",metrics:[],days:Array.from({length:7},(_,i)=>({date:date(end-(7-i)*DAY),value:null})),paths:[],countries:[],referrers:[],notes:[
    "全部窗口截至最新完整 UTC 日（北京时间 08:00）；24h / 3d / 7d 分别对比紧邻的前 24h / 3d / 7d。小时数据保留期不足以覆盖前 7 天。",
    "Cloudflare zone 请求和 IP 指标包含机器人；uniq.uniques 使用服务端整个窗口聚合，不相加每日 IP 数。RUM visits 是浏览器访问次数，不是去重自然人数，可能受拦截器影响。",
    "Top 列表为最近 24h；Adaptive 数据为抽样估算。路径过滤静态文件、框架资源与 /cdn-cgi/；referrer 使用 RUM 页面加载来源，仅显示域名（zone 套餐不开放 referrer 字段）。",
    "D1 扫描数为 complete_public / partial_public 的 updated_at 窗口计数，不等同新评分或首次账号数。注册、登录、评分与首次账号时间列无适用索引，未扫描。卡片/锐评无可用的持久化时间索引表；MCP / GitHub App 无独立统计口径。",
  ]};
  const ps=periods(end);
  let zone:Record<string,Row[]>|undefined,rum:Record<string,Row[]>|undefined;
  const record=(source:string,e:unknown)=>report.notes.push(`${source}：${reason(e)}`);
  // Four bounded GraphQL calls, rather than one query per path/account/day.
  await Promise.all([
    (async()=>{try{
      zone=await query(config,"zones",ps.map(p=>`${p.name}:httpRequests1dGroups(limit:1,filter:{date_geq:"${date(p.start)}",date_lt:"${date(p.end)}"}){sum{requests pageViews bytes responseStatusMap{edgeResponseStatus requests}} uniq{uniques}}`).join(" ")+` daily:httpRequests1dGroups(limit:7,orderBy:[date_ASC],filter:{date_geq:"${date(end-7*DAY)}",date_lt:"${date(end)}"}){dimensions{date} uniq{uniques}}`,fetcher);
    }catch(e){record(config.zone?"Zone Analytics":"缺少 CF_ZONE_ID 配置",e);}})(),
    (async()=>{try{
      const host=JSON.stringify(config.host??"ghfind.com");
      rum=await query(config,"accounts",ps.map(p=>`${p.name}:rumPageloadEventsAdaptiveGroups(limit:1,filter:{datetime_geq:"${iso(p.start)}",datetime_lt:"${iso(p.end)}",requestHost:${host}}){count sum{visits}}`).join(" ")+` daily:rumPageloadEventsAdaptiveGroups(limit:7,orderBy:[date_ASC],filter:{datetime_geq:"${iso(end-7*DAY)}",datetime_lt:"${iso(end)}",requestHost:${host}}){dimensions{date} sum{visits}} referrers:rumPageloadEventsAdaptiveGroups(limit:10,orderBy:[count_DESC],filter:{datetime_geq:"${iso(end-DAY)}",datetime_lt:"${iso(end)}",requestHost:${host}}){count dimensions{refererHost}}`,fetcher);
      report.referrers=top(rum.referrers,"refererHost");
    }catch(e){record("Web Analytics / RUM",e);}})(),
    (async()=>{try{
      const range=`datetime_geq:"${iso(end-DAY)}",datetime_lt:"${iso(end)}",requestSource:"eyeball"`;
      const exclude=["/_next/%","/_astro/%","/cdn-cgi/%","/fonts/%","%.js","%.css","%.png","%.jpg","%.jpeg","%.svg","%.webp","%.gif","%.ico","%.woff%","%.ttf","%.otf","%.eot","%.map","%.avif","%.txt","%.xml"];
      const pathFilter=exclude.map(p=>`{clientRequestPath_notlike:${JSON.stringify(p)}}`).join(",");
      const rows=await query(config,"zones",`paths:httpRequestsAdaptiveGroups(limit:10,orderBy:[count_DESC],filter:{${range},AND:[${pathFilter}]}){count dimensions{clientRequestPath}} countries:httpRequestsAdaptiveGroups(limit:10,orderBy:[count_DESC],filter:{${range}}){count dimensions{clientCountryName}}`,fetcher);
      report.paths=top(rows.paths,"clientRequestPath");report.countries=top(rows.countries,"clientCountryName");
    }catch(e){record("Top 列表",e);}})(),
    (async()=>{try{
      const rows=await query(config,"zones",ps.map(p=>`${p.name}:httpRequestsAdaptiveGroups(limit:1,filter:{datetime_geq:"${iso(p.start)}",datetime_lt:"${iso(p.end)}",requestSource:"eyeball",clientRequestPath_like:"/api/%"}){count}`).join(" "),fetcher);
      report.metrics.push({key:"api",label:"API 请求（估算）",values:values(rows,r=>numeric(r.count))});
    }catch(e){record("API 请求",e);}})(),
  ]);
  const rumValues=values(rum,r=>numeric(r.sum?.visits));
  // Empty RUM may mean instrumentation disabled. Do not turn it into zero users
  // or mix RUM and IP definitions across comparison windows.
  const useRum=rumValues.every(v=>v.current!==null&&v.previous!==null)&&rumValues.some(v=>(v.current??0)>0||(v.previous??0)>0);
  if(useRum)report.visitorSource="RUM 浏览器访问（visits，非去重人数）";
  else report.notes.push("RUM 未提供完整且非空的比较窗口，访客回落 Cloudflare 唯一 IP；缺失值显示 —，不视为 0。");
  const base:TrafficMetric[]=[{key:"visitors",label:useRum?"访客 · RUM visits":"访客 · 唯一 IP",values:useRum?rumValues:values(zone,r=>numeric(r.uniq?.uniques))},
    {key:"requests",label:"请求数",values:values(zone,r=>numeric(r.sum?.requests))},
    {key:"pageViews",label:useRum?"页面浏览 · RUM":"页面浏览 · zone",values:values(useRum?rum:zone,r=>numeric(useRum?r.count:r.sum?.pageViews))},
    {key:"bytes",label:"带宽",unit:"bytes",values:values(zone,r=>numeric(r.sum?.bytes))},
    ...[4,5].map(status=>({key:`${status}xx`,label:`${status}xx 比例`,unit:"percent" as const,values:values(zone,r=>{
      const total=numeric(r.sum?.requests),map=r.sum?.responseStatusMap;
      if(!Array.isArray(map))throw new Error("Missing status map");
      const failed=map.filter(x=>Math.floor(numeric(x.edgeResponseStatus)/100)===status).reduce((n,x)=>n+numeric(x.requests),0);
      return total?failed/total*100:0;
    })})),
  ];
  report.metrics=[...base,...(useRum?[{key:"uniqueIPs",label:"唯一 IP · zone",values:values(zone,r=>numeric(r.uniq?.uniques))},{key:"zonePageViews",label:"页面浏览 · zone",values:values(zone,r=>numeric(r.sum?.pageViews))}]:[]),...report.metrics];
  const daily=useRum?rum?.daily:zone?.daily;
  report.days=report.days.map(d=>{const r=daily?.find(r=>r.dimensions?.date===d.date);try{return {...d,value:r?numeric(useRum?r.sum?.visits:r.uniq?.uniques):null};}catch{return d;}});
  if(config.db){
    try{
      const plan=await config.db.prepare(`EXPLAIN QUERY PLAN ${SCAN_COUNT_SQL}`).bind(end-DAY,end).all<{detail:string}>();
      if(!plan.results.some(r=>/SEARCH .*USING COVERING INDEX idx_public_scan_runs_state/.test(r.detail))||plan.results.some(r=>/SCAN /.test(r.detail)))throw new Error("Index unavailable");
      const rows=await config.db.batch<{n:number}>(ps.map(p=>config.db!.prepare(SCAN_COUNT_SQL).bind(p.start,p.end)));
      report.metrics.push({key:"scans",label:"完成扫描（更新时间）",values:WINDOWS.map((_,i)=>({current:numeric(rows[i*2].results[0]?.n),previous:numeric(rows[i*2+1].results[0]?.n)}))});
    }catch(e){record("D1 索引范围统计",e);}
  }else report.notes.push("D1 未绑定，扫描统计不可用。");
  return report;
}

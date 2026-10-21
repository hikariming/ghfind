import { boundedJson } from "./metrics";
export const DAY = 86400_000;
export interface Comparison { current: number | null; previous: number | null; currentReason?:string; previousReason?:string }
export interface TrafficMetric { key:string; label:string; unit?:"bytes"|"percent"; values:Comparison[] }
export interface Ranking { label:string; value:number }
export interface RequestDay { date:string; total:number|null; browser:number|null; api:number|null; other:number|null; reason?:string }
export interface RequestTraffic { source:string; values:Comparison[]; days:RequestDay[]; breakdownReason?:string; workers:{values:Comparison[]; scripts:Ranking[]} }
export interface TrafficReport {
  generatedAt:number; end:number; requests?:RequestTraffic; visitorSource:string; metrics:TrafficMetric[];
  days:{date:string; value:number|null}[];
  paths:Ranking[]; countries:Ranking[]; referrers:Ranking[]; notes:string[]; unavailable?:Partial<Record<"paths"|"countries"|"referrers",string>>;
}
export interface TrafficConfig { account:string; token:string; zone?:string; host?:string; db?:D1Database }
type Row = {sum?:Record<string,unknown>; uniq?:{uniques:number}; count?:number; dimensions?:Record<string,string>};
const date=(at:number)=>new Date(at).toISOString().slice(0,10);
const iso=(at:number)=>new Date(at).toISOString();
function numeric(value:unknown):number {if(typeof value!=="number"||!Number.isFinite(value)||value<0)throw new Error("Invalid metric");return value;}
function reason(error:unknown,scope:"zones"|"accounts"="zones"):string {
  const message=error instanceof Error?error.message:"";
  if(/Zone configuration missing/.test(message))return "缺少 CF_ZONE_ID 配置";
  if(/does not have access to the field|not entitled|not supported/i.test(message))return "套餐不支持该字段，需调整 Analytics 套餐或改用可用数据源";
  if(/access|permission|unauthor|forbidden|HTTP 40[13]/i.test(message))return scope==="zones"?"需要 Zone Analytics 读权限":"需要 Account Analytics 读权限";
  if(/budget|429|rate.?limit/i.test(message))return "本次限流未取到（已重试一次）";
  return "数据源不可用或响应不完整";
}
async function queryOnce<T=Record<string,Row[]>>(config:TrafficConfig,scope:"zones"|"accounts",selection:string,fetcher:typeof fetch):Promise<T> {
  if(scope==="zones"&&!/^[a-f0-9]{32}$/i.test(config.zone??""))throw new Error("Zone configuration missing");
  const filter=scope==="zones"?`zoneTag:${JSON.stringify(config.zone)}`:`accountTag:${JSON.stringify(config.account)}`;
  const payload=await boundedJson(await fetcher("https://api.cloudflare.com/client/v4/graphql",{method:"POST",headers:{authorization:`Bearer ${config.token}`,"content-type":"application/json"},body:JSON.stringify({query:`{viewer{${scope}(filter:{${filter}}){${selection}}}}`}),signal:AbortSignal.timeout(20_000)})) as {errors?:{message:string}[];data?:{viewer?:Record<string,Record<string,Row[]>[]>}};
  if(payload.errors?.length)throw new Error(payload.errors.map(e=>e.message).join(" "));
  const rows=payload.data?.viewer?.[scope];
  if(!Array.isArray(rows)||rows.length!==1)throw new Error("Missing metrics");
  return rows[0] as T;
}
async function query<T=Record<string,Row[]>>(config:TrafficConfig,scope:"zones"|"accounts",selection:string,fetcher:typeof fetch):Promise<T> {
  try{return await queryOnce<T>(config,scope,selection,fetcher);}catch(e){
    if(!/budget|429|rate.?limit/i.test(e instanceof Error?e.message:""))throw e;
    await new Promise(resolve=>setTimeout(resolve,250));
    return queryOnce<T>(config,scope,selection,fetcher);
  }
}
const WINDOWS=[1,3,7];
const periods=(end:number)=>WINDOWS.flatMap(days=>[0,1].map(previous=>({name:`w${days}p${previous}`,start:end-days*DAY*(previous+1),end:end-days*DAY*previous})));
interface Retention { enabled:boolean; maxDuration:number; notOlderThan:number }
interface Dataset { rows?:Record<string,Row[]>; retention?:Retention; error?:string }
function retained(retention:Retention|undefined,now:number,start:number,end:number):boolean {
  return !!retention?.enabled && start>=now-retention.notOlderThan*1000 && end-start<=retention.maxDuration*1000;
}
// A non-empty aggregate does not establish coverage: an expired/missing day can
// silently turn a seven-day denominator into one day. Inspect each UTC bucket.
function values(source:Dataset,read:(row:Row)=>number,end:number,now:number):Comparison[] {
  return WINDOWS.map(days=>{
    const result:Comparison={current:null,previous:null};
    for(const previous of [0,1]){
      const side=previous?"previous":"current",why=previous?"previousReason":"currentReason";
      const start=end-days*DAY*(previous+1),stop=end-days*DAY*previous;
      if(source.error){result[why]=source.error;continue;}
      let missing=0;
      for(let at=start;at<stop;at+=DAY){
        const matches=source.rows?.daily?.filter(r=>r.dimensions?.date===date(at));
        try{if(!retained(source.retention,now,at,at+DAY)||matches?.length!==1)throw new Error();read(matches[0]);}catch{missing++;}
      }
      if(missing){result[why]=`${previous?"前期":"本期"}数据不足 ${missing} 天`;continue;}
      if(!retained(source.retention,now,start,stop)){result[why]="超出 Analytics 查询窗口限制";continue;}
      try{
        const rows=source.rows?.[`w${days}p${previous}`];
        if(rows?.length!==1)throw new Error();
        result[side]=read(rows[0]);
      }catch{result[why]="窗口汇总不可用";}
    }
    return result;
  });
}
async function discovery(config:TrafficConfig,scope:"zones"|"accounts",names:string[],fetcher:typeof fetch):Promise<Record<string,Dataset>> {
  try{
    const data=await query<{settings:Record<string,Retention>}>(config,scope,`settings{${names.map(n=>`${n}{enabled maxDuration notOlderThan}`).join(" ")}}`,fetcher);
    return Object.fromEntries(names.map(name=>{
      const r=data.settings?.[name];
      return [name,r?.enabled&&Number.isFinite(r.maxDuration)&&r.maxDuration>0&&Number.isFinite(r.notOlderThan)&&r.notOlderThan>0?{retention:r}:{error:"套餐未开放数据源或无法确认保留期"}];
    }));
  }catch(e){return Object.fromEntries(names.map(n=>[n,{error:reason(e,scope)}]));}
}
function dailyStart(source:Dataset,now:number,end:number):number {
  return Math.min(end,Math.max(end-14*DAY,Math.ceil((now-(source.retention?.notOlderThan??0)*1000)/DAY)*DAY));
}
function top(rows:Row[]|undefined,dimension:string):Ranking[] {
  if(!Array.isArray(rows))return [];
  return rows.slice(0,10).map(r=>({label:String(r.dimensions?.[dimension]??"直接访问").slice(0,240)||"直接访问",value:numeric(r.count)}));
}
// The existing covering index bounds the query by state and time. INDEXED BY
// fails closed if a deployment lacks the index; never fall back to a table scan.
export const SCAN_COUNT_SQL="SELECT COUNT(*) AS n FROM public_scan_runs INDEXED BY idx_public_scan_runs_state WHERE state IN ('complete_public','partial_public') AND updated_at >= ? AND updated_at < ?";
export async function collectTraffic(config:TrafficConfig,now=Date.now(),fetcher=fetch):Promise<TrafficReport> {
  // UTC-day cutoff is intentionally earlier for manual sends before local 08:00.
  // Retention is discovered per dataset and checked against collection time.
  const end=Math.floor(now/DAY)*DAY;
  const report:TrafficReport={generatedAt:now,end,visitorSource:"Cloudflare 唯一 IP（非独立自然人）",metrics:[],days:Array.from({length:7},(_,i)=>({date:date(end-(7-i)*DAY),value:null})),paths:[],countries:[],referrers:[],unavailable:{},notes:[
    "全部窗口截至最新完整 UTC 日（北京时间 08:00）；24h / 3d / 7d 分别对比紧邻的前 24h / 3d / 7d。逐日检查保留期与完整性，缺少日期不按 0 计算。",
    "Cloudflare zone 请求和 IP 指标包含机器人；uniq.uniques 使用服务端整个窗口聚合，不相加每日 IP 数。RUM visits 是浏览器访问次数，不是去重自然人数，可能受拦截器影响。",
    "Top 列表为最近 24h；Adaptive 数据为抽样估算。路径过滤静态文件、框架资源与 /cdn-cgi/；referrer 使用 RUM 页面加载来源，仅显示域名（zone 套餐不开放 referrer 字段）。",
    "D1 扫描数为 complete_public / partial_public 的 updated_at 窗口计数，不等同新评分或首次账号数。注册、登录、评分与首次账号时间列无适用索引，未扫描。卡片/锐评无可用的持久化时间索引表；MCP / GitHub App 无独立统计口径。",
  ]};
  const ps=periods(end);
  const [zoneSettings,rumSettings]=await Promise.all([
    discovery(config,"zones",["httpRequests1dGroups","httpRequestsAdaptiveGroups"],fetcher),
    discovery(config,"accounts",["rumPageloadEventsAdaptiveGroups","workersInvocationsAdaptive"],fetcher),
  ]);
  const zone=zoneSettings.httpRequests1dGroups,api=zoneSettings.httpRequestsAdaptiveGroups,rum=rumSettings.rumPageloadEventsAdaptiveGroups,workers=rumSettings.workersInvocationsAdaptive;
  let browserDays:Row[]|undefined,breakdownReason:string|undefined;
  const apiPaths='OR:[{clientRequestPath_like:"/api/%"},{clientRequestPath:"/api"},{clientRequestPath:"/mcp"},{clientRequestPath_like:"/mcp/%"},{clientRequestPath_like:"/webhooks%"},{clientRequestPath:"/webhook"}]';
  const fail=(source:Dataset,label:string,e:unknown,scope:"zones"|"accounts"="zones")=>{source.error=reason(e,scope);report.notes.push(`${label}：${source.error}`);};
  const selections=(source:Dataset)=>ps.filter(p=>retained(source.retention,now,p.start,p.end));
  const zoneFields="sum{requests pageViews bytes responseStatusMap{edgeResponseStatus requests}} uniq{uniques}";
  // Two discovery calls and five bounded data calls. Unsupported comparison
  // periods are omitted so they cannot invalidate shorter, available windows.
  await Promise.all([
    (async()=>{if(zone.error)return;try{
      zone.rows=await query(config,"zones",selections(zone).map(p=>`${p.name}:httpRequests1dGroups(limit:1,filter:{date_geq:"${date(p.start)}",date_lt:"${date(p.end)}"}){${zoneFields}}`).join(" ")+` daily:httpRequests1dGroups(limit:14,orderBy:[date_ASC],filter:{date_geq:"${date(dailyStart(zone,now,end))}",date_lt:"${date(end)}"}){dimensions{date} ${zoneFields}}`,fetcher);
    }catch(e){fail(zone,"Zone Analytics",e);}})(),
    (async()=>{if(rum.error){report.unavailable!.referrers=rum.error;return;}try{
      const host=JSON.stringify(config.host??"ghfind.com");
      const refs=retained(rum.retention,now,end-DAY,end)?` referrers:rumPageloadEventsAdaptiveGroups(limit:10,orderBy:[count_DESC],filter:{datetime_geq:"${iso(end-DAY)}",datetime_lt:"${iso(end)}",requestHost:${host}}){count dimensions{refererHost}}`:"";
      rum.rows=await query(config,"accounts",selections(rum).map(p=>`${p.name}:rumPageloadEventsAdaptiveGroups(limit:1,filter:{datetime_geq:"${iso(p.start)}",datetime_lt:"${iso(p.end)}",requestHost:${host}}){count sum{visits}}`).join(" ")+` daily:rumPageloadEventsAdaptiveGroups(limit:14,orderBy:[date_ASC],filter:{datetime_geq:"${iso(dailyStart(rum,now,end))}",datetime_lt:"${iso(end)}",requestHost:${host}}){dimensions{date} count sum{visits}}`+refs,fetcher);
      report.referrers=top(rum.rows?.referrers,"refererHost");
      if(!refs)report.unavailable!.referrers="本期数据不足 1 天";
    }catch(e){fail(rum,"Web Analytics / RUM",e,"accounts");report.unavailable!.referrers=rum.error;}})(),
    (async()=>{if(api.error||!retained(api.retention,now,end-DAY,end)){report.unavailable!.paths=report.unavailable!.countries=api.error??"本期数据不足 1 天";return;}try{
      const range=`datetime_geq:"${iso(end-DAY)}",datetime_lt:"${iso(end)}",requestSource:"eyeball"`;
      const exclude=["/_next/%","/_astro/%","/cdn-cgi/%","/fonts/%","%.js","%.css","%.png","%.jpg","%.jpeg","%.svg","%.webp","%.gif","%.ico","%.woff%","%.ttf","%.otf","%.eot","%.map","%.avif","%.txt","%.xml"];
      const pathFilter=exclude.map(p=>`{clientRequestPath_notlike:${JSON.stringify(p)}}`).join(",");
      const rows=await query(config,"zones",`paths:httpRequestsAdaptiveGroups(limit:10,orderBy:[count_DESC],filter:{${range},AND:[${pathFilter}]}){count dimensions{clientRequestPath}} countries:httpRequestsAdaptiveGroups(limit:10,orderBy:[count_DESC],filter:{${range}}){count dimensions{clientCountryName}} browserDaily:httpRequestsAdaptiveGroups(limit:14,orderBy:[date_ASC],filter:{datetime_geq:"${iso(dailyStart(api,now,end))}",datetime_lt:"${iso(end)}",requestSource:"eyeball",userAgent_like:"%Mozilla/%",AND:[${pathFilter},{clientRequestPath_notlike:"/api/%"},{clientRequestPath_neq:"/api"},{clientRequestPath_neq:"/mcp"},{clientRequestPath_notlike:"/mcp/%"},{clientRequestPath_notlike:"/webhooks%"},{clientRequestPath_neq:"/webhook"}]}){count dimensions{date}}`,fetcher);
      report.paths=top(rows.paths,"clientRequestPath");report.countries=top(rows.countries,"clientCountryName");browserDays=rows.browserDaily;
    }catch(e){report.unavailable!.paths=report.unavailable!.countries=breakdownReason=reason(e);}})(),
    (async()=>{if(api.error)return;try{
      api.rows=await query(config,"zones",selections(api).map(p=>`${p.name}:httpRequestsAdaptiveGroups(limit:1,filter:{datetime_geq:"${iso(p.start)}",datetime_lt:"${iso(p.end)}",requestSource:"eyeball",${apiPaths}}){count}`).join(" ")+` daily:httpRequestsAdaptiveGroups(limit:14,orderBy:[date_ASC],filter:{datetime_geq:"${iso(dailyStart(api,now,end))}",datetime_lt:"${iso(end)}",requestSource:"eyeball",${apiPaths}}){count dimensions{date}} `+selections(api).map(p=>`t${p.name}:httpRequestsAdaptiveGroups(limit:1,filter:{datetime_geq:"${iso(p.start)}",datetime_lt:"${iso(p.end)}",requestSource:"eyeball"}){count}`).join(" ")+` totalDaily:httpRequestsAdaptiveGroups(limit:14,orderBy:[date_ASC],filter:{datetime_geq:"${iso(dailyStart(api,now,end))}",datetime_lt:"${iso(end)}",requestSource:"eyeball"}){count dimensions{date}}`,fetcher);
    }catch(e){fail(api,"API 请求",e);}})(),
    (async()=>{if(workers.error)return;try{
      // This is a service invocation supplement, not a unique edge-request count.
      const scripts='scriptName_in:["ghfind-router","ghfind-web","ghfind-api","ghfind"]';
      workers.rows=await query(config,"accounts",selections(workers).map(p=>`${p.name}:workersInvocationsAdaptive(limit:1,filter:{datetime_geq:"${iso(p.start)}",datetime_lt:"${iso(p.end)}",${scripts}}){sum{requests}}`).join(" ")+` daily:workersInvocationsAdaptive(limit:14,orderBy:[date_ASC],filter:{datetime_geq:"${iso(dailyStart(workers,now,end))}",datetime_lt:"${iso(end)}",${scripts}}){dimensions{date} sum{requests}} scripts:workersInvocationsAdaptive(limit:8,filter:{datetime_geq:"${iso(end-DAY)}",datetime_lt:"${iso(end)}",${scripts}}){dimensions{scriptName} sum{requests}}`,fetcher);
    }catch(e){fail(workers,"Workers 调用",e,"accounts");}})(),
  ]);
  for(const [label,source] of [["Zone Analytics",zone],["RUM",rum],["Workers",workers]] as const)if(source.error&&!report.notes.includes(`${label}：${source.error}`))report.notes.push(`${label}：${source.error}`);
  const totals:Dataset={...api,rows:api.rows?Object.fromEntries([...ps.map(p=>[p.name,api.rows?.[`t${p.name}`]??[]]),["daily",api.rows.totalDaily??[]]]):undefined};
  const edgeValues=values(totals,r=>numeric(r.count),end,now),workerValues=values(workers,r=>numeric(r.sum?.requests),end,now);
  const adaptiveAvailable=edgeValues.some(v=>v.current!==null);
  const zoneValues=values(zone,r=>numeric(r.sum?.requests),end,now);
  const zoneAvailable=zoneValues.some(v=>v.current!==null);
  const requestDays=report.days.map(day=>{
    const at=Date.parse(day.date),source=adaptiveAvailable?totals:zoneAvailable?zone:workers;
    const matches=source.rows?.daily?.filter(r=>r.dimensions?.date===day.date);
    let total:number|null=null;
    try{if(!retained(source.retention,now,at,at+DAY)||matches?.length!==1)throw new Error();total=numeric(adaptiveAvailable?matches[0].count:matches[0].sum?.requests);}catch{}
    const missing:RequestDay={date:day.date,total,browser:null,api:null,other:null};
    if(!adaptiveAvailable||total===null)return missing;
    // A missing segment bucket may be no events OR missing telemetry. Do not
    // manufacture zero; preserve the total and explicitly omit the split.
    try{
      const b=browserDays?.filter(r=>r.dimensions?.date===day.date),a=api.rows?.daily?.filter(r=>r.dimensions?.date===day.date);
      if(b?.length!==1||a?.length!==1)throw new Error();
      const browser=numeric(b[0].count),apiCount=numeric(a[0].count);
      if(browser+apiCount>total)throw new Error();
      return {...missing,browser,api:apiCount,other:total-browser-apiCount};
    }catch{return {...missing,reason:breakdownReason??api.error??"分类数据不足或抽样汇总不一致"};}
  });
  report.requests={source:adaptiveAvailable?"边缘全部请求（Adaptive 抽样估算）":zoneAvailable?"边缘全部请求（zone 日汇总，分类不可用）":"Workers 调用兜底（非边缘去重请求）",values:adaptiveAvailable?edgeValues:zoneAvailable?zoneValues:workerValues,days:requestDays,breakdownReason:adaptiveAvailable?breakdownReason:totals.error??edgeValues[0].currentReason,workers:{values:workerValues,scripts:(workers.rows?.scripts??[]).map(r=>({label:String(r.dimensions?.scriptName??"Worker"),value:numeric(r.sum?.requests)}))}};
  report.notes.push("全部请求覆盖 API/MCP/webhook、爬虫和脚本。浏览器页面按 Mozilla UA 且排除 API/静态路径估算；UA 可伪造，套餐不开放 Accept 维度，不等同真人。其他包含非浏览器、静态和未分类请求。",
    "请求图和其合计使用同一数据集；Adaptive 不可用时改用 zone 日汇总，再兜底 Workers 调用。Workers 补充仅含 ghfind 的 router/web/api/legacy 服务，一次边缘请求可触发多个调用，不与边缘请求相加。分类不可用时只显示总量灰柱。");
  const rumValues=values(rum,r=>numeric(r.sum?.visits),end,now);
  // Missing prior days suppress only that comparison, never switch a valid
  // current RUM window to a different visitor definition.
  const useRum=rumValues.some(v=>v.current!==null&&v.current>0);
  if(useRum)report.visitorSource="RUM 浏览器访问（visits，非去重人数）";
  else report.notes.push("RUM 本期没有完整且非空的窗口，访客回落 Cloudflare 唯一 IP；缺失值不视为 0。");
  const record=(source:string,e:unknown)=>report.notes.push(`${source}：${reason(e)}`);
  const base:TrafficMetric[]=[{key:"visitors",label:useRum?"访客 · RUM visits":"访客 · 唯一 IP",values:useRum?rumValues:values(zone,r=>numeric(r.uniq?.uniques),end,now)},
    {key:"requests",label:"请求数",values:values(zone,r=>numeric(r.sum?.requests),end,now)},
    {key:"pageViews",label:useRum?"页面浏览 · RUM":"页面浏览 · zone",values:values(useRum?rum:zone,r=>numeric(useRum?r.count:r.sum?.pageViews),end,now)},
    {key:"bytes",label:"带宽",unit:"bytes",values:values(zone,r=>numeric(r.sum?.bytes),end,now)},
    ...[4,5].map(status=>({key:`${status}xx`,label:`${status}xx 比例`,unit:"percent" as const,values:values(zone,r=>{
      const total=numeric(r.sum?.requests),map=r.sum?.responseStatusMap;
      if(!Array.isArray(map))throw new Error("Missing status map");
      const failed=map.filter(x=>Math.floor(numeric(x.edgeResponseStatus)/100)===status).reduce((n,x)=>n+numeric(x.requests),0);
      return total?failed/total*100:0;
    },end,now)})),
  ];
  report.metrics=[...base,...(useRum?[{key:"uniqueIPs",label:"唯一 IP · zone",values:values(zone,r=>numeric(r.uniq?.uniques),end,now)},{key:"zonePageViews",label:"页面浏览 · zone",values:values(zone,r=>numeric(r.sum?.pageViews),end,now)}]:[]),{key:"api",label:"API 请求（估算）",values:values(api,r=>numeric(r.count),end,now)}];
  const dailySource=useRum?rum:zone;
  report.days=report.days.map(d=>{const rows=dailySource.rows?.daily?.filter(r=>r.dimensions?.date===d.date),at=Date.parse(d.date);try{if(rows?.length!==1||!retained(dailySource.retention,now,at,at+DAY))return d;return {...d,value:numeric(useRum?rows[0].sum?.visits:rows[0].uniq?.uniques)};}catch{return d;}});
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

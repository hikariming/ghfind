import { MAX_POINTS, MAX_WINDOW_BYTES, WINDOW_MS, type Frame, type Point, type Product } from "./engine";
export interface CollectorConfig { account: string; token: string }
interface Row { dimensions: Record<string,string>; sum?: Record<string,number>; max?: Record<string,number>; count?: number }
const LIMIT = 128;
const MAX_RESPONSE = 2 * 1024 * 1024;
const INGESTION_LAG_MS = 2 * WINDOW_MS;
export const STORAGE_LOOKBACK_MS = 3 * 3600_000;
// Only fixed categories leave this module: upstream messages can include query
// text, credentials or account details and must never enter state or mail.
function unavailable(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (/^HTTP (401|403)$/.test(message) || message === "GraphQL access denied") return "access denied; check analytics token permissions";
  if (message === "HTTP 429" || message === "GraphQL rate limited") return "rate limited; retry next scheduled window";
  if (message === "GraphQL dataset unavailable") return "dataset unavailable or unsupported";
  if (message === "Metric result truncated") return "result limit reached; coverage incomplete";
  if (message === "API response exceeds limit") return "response size limit reached; coverage incomplete";
  if (error instanceof Error && ["AbortError", "TimeoutError"].includes(error.name)) return "request timed out";
  return "collection unavailable";
}
export async function boundedJson(response: Response): Promise<unknown> {
  if (!response.ok) { await response.body?.cancel(); throw new Error(`HTTP ${response.status}`); }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Empty API response");
  let bytes = 0; let text = ""; const decoder = new TextDecoder();
  try {
    while (true) { const chunk = await reader.read(); if (chunk.done) break; bytes += chunk.value.byteLength; if (bytes > MAX_RESPONSE) throw new Error("API response exceeds limit"); text += decoder.decode(chunk.value, {stream:true}); }
    return JSON.parse(text + decoder.decode());
  } finally { await reader.cancel(); }
}
function object(value: unknown): Record<string,unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid API object");
  return value as Record<string,unknown>;
}
function number(row: Row, name: string, kind: "sum" | "max" = "sum"): number {
  const n = row[kind]?.[name];
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0) throw new Error(`Invalid ${name} metric`);
  return n;
}
async function graphql(config: CollectorConfig, selection: string, fetcher: typeof fetch): Promise<Row[]> {
  const response = await fetcher("https://api.cloudflare.com/client/v4/graphql", {
    method: "POST", headers: {authorization:`Bearer ${config.token}`, "content-type":"application/json"},
    body: JSON.stringify({query:`{viewer{accounts(filter:{accountTag:${JSON.stringify(config.account)}}){rows:${selection}}}}`}), signal:AbortSignal.timeout(20_000),
  });
  const payload = object(await boundedJson(response));
  if (Array.isArray(payload.errors) && payload.errors.length) {
    const messages = payload.errors.map(e => typeof e === "object" && e !== null && "message" in e ? String(e.message) : "").join(" ");
    if (/rate.?limit|too many requests/i.test(messages)) throw new Error("GraphQL rate limited");
    if (/unauthori[sz]ed|permission|access denied|not allowed/i.test(messages)) throw new Error("GraphQL access denied");
    if (/unknown (field|argument)|cannot query|not available|not supported|not entitled/i.test(messages)) throw new Error("GraphQL dataset unavailable");
    throw new Error("GraphQL collection failed");
  }
  const accounts = object(object(payload.data).viewer).accounts;
  if (!Array.isArray(accounts) || accounts.length !== 1) throw new Error("Account metrics unavailable");
  const rows = object(accounts[0]).rows;
  if (!Array.isArray(rows)) throw new Error("Metric result unavailable");
  if (rows.length >= LIMIT) throw new Error("Metric result truncated");
  return rows.map(value => {
    const row = object(value); const dimensions = object(row.dimensions);
    if (Object.values(dimensions).some(v => typeof v !== "string")) throw new Error("Invalid metric dimensions");
    return { dimensions: dimensions as Record<string,string>, ...(row.sum ? {sum:object(row.sum) as Record<string,number>} : {}), ...(row.max ? {max:object(row.max) as Record<string,number>} : {}), ...(typeof row.count === "number" ? {count:row.count} : {}) };
  });
}
function metric(product: Product, resource: string, label: string, amount: number, operations: number, unit: string, price: number, suffix: string, extra: Partial<Point> = {}): Point {
  if (typeof resource !== "string" || !resource || resource.length > 100 || !Number.isFinite(amount) || !Number.isFinite(operations) || amount < 0 || operations < 0) throw new Error("Invalid metric dimensions or values");
  return {key:`${product}:${resource}:${suffix}`, product, resource, label, amount, operations, unit, usd:amount*price, ...extra};
}
async function fingerprint(sql: string): Promise<string> {
  const normalized = sql.replace(/'(?:''|[^'])*'/g,"?").replace(/\b\d+(?:\.\d+)?\b/g,"?").replace(/\s+/g," ").trim();
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(normalized));
  return Array.from(new Uint8Array(bytes).slice(0,8),b=>b.toString(16).padStart(2,"0")).join("");
}
const CLASS_A = new Set(["ListBuckets","PutBucket","ListObjects","ListObjectsV2","PutObject","CopyObject","CompleteMultipartUpload","CreateMultipartUpload","UploadPart","UploadPartCopy","PutBucketEncryption","PutBucketLifecycleConfiguration","PutBucketCors","PutBucketLogging","LifecycleStorageTierTransition","ListMultipartUploads","ListParts"]);
const CLASS_B = new Set(["HeadBucket","HeadObject","GetObject","GetBucketEncryption","GetBucketLocation","GetBucketLifecycleConfiguration","GetBucketCors","GetBucketLogging","GetUsageSummary","UsageSummary"]);
const FREE = new Set(["DeleteObject","DeleteObjects","DeleteBucket","AbortMultipartUpload","DeleteBucketLifecycle","DeleteBucketLifecycleConfiguration","DeleteBucketCors","DeleteBucketEncryption"]);
export async function collect(config: CollectorConfig, now = Date.now(), fetcher = fetch): Promise<Frame> {
  // Read a closed window behind ingestion lag; dedupe by window timestamp in storage.
  const end = Math.floor(now/WINDOW_MS)*WINDOW_MS - INGESTION_LAG_MS;
  const at = end - WINDOW_MS;
  const filter = `filter:{datetime_geq:${JSON.stringify(new Date(at).toISOString())},datetime_lt:${JSON.stringify(new Date(end).toISOString())}}`;
  const frame: Frame = {at, points:[], healthy:[], errors:[], diagnostics:[]};
  const sources: {product:Product; name:string; selection:string; convert:(rows:Row[])=>Promise<Point[]> | Point[]}[] = [
    {product:"D1",name:"D1",selection:`d1AnalyticsAdaptiveGroups(limit:${LIMIT},${filter}){dimensions{databaseId} sum{rowsRead rowsWritten readQueries writeQueries}}`,convert: rows=>rows.flatMap(r=> {
      const reads=number(r,"rowsRead"),writes=number(r,"rowsWritten"),rq=number(r,"readQueries"),wq=number(r,"writeQueries");
      return [metric("D1",r.dimensions.databaseId,"数据库读取",reads,rq,"rows",1e-9,"read",{efficiency:rq?reads/rq:0,efficiencyWarning:50_000,efficiencyCritical:200_000,minAmount:100_000}),metric("D1",r.dimensions.databaseId,"数据库写入",writes,wq,"rows",1e-6,"write",{efficiency:wq?writes/wq:0,efficiencyWarning:500,efficiencyCritical:5000,minAmount:1000})];
    })},
    {product:"Workers",name:"Workers",selection:`workersInvocationsAdaptive(limit:${LIMIT},${filter}){dimensions{scriptName} sum{requests errors cpuTimeUs}}`,convert:rows=>{
      // Adaptive invocation rows can repeat a script name (including __unknown__).
      const scripts=new Map<string,{requests:number;cpu:number;errors:number}>();
      for(const r of rows){const name=r.dimensions.scriptName,previous=scripts.get(name)??{requests:0,cpu:0,errors:0};previous.requests+=number(r,"requests");previous.errors+=number(r,"errors");previous.cpu+=number(r,"cpuTimeUs")/1000;scripts.set(name,previous);}
      return [...scripts].flatMap(([name,{requests,cpu,errors}])=>[metric("Workers",name,"请求",requests,requests,"requests",0.3e-6,"requests",{efficiency:1}),metric("Workers",name,"CPU",cpu,requests,"CPU ms",0.02e-6,"cpu",{efficiency:requests?cpu/requests:0,efficiencyWarning:1000,efficiencyCritical:5000,minAmount:10_000}),metric("Workers",name,"Worker 运行错误",errors,requests,"errors",0,"errors",{relative:false,minAmount:3,minOperations:20,efficiency:requests?errors/requests:0,efficiencyWarning:0.01,efficiencyCritical:0.05})]);
    }},
    {product:"R2",name:"R2 operations",selection:`r2OperationsAdaptiveGroups(limit:${LIMIT},${filter}){dimensions{bucketName actionType storageClass} sum{requests responseObjectSize}}`,convert:rows=>rows.flatMap(r=>{
      const action=r.dimensions.actionType,ia=r.dimensions.storageClass==="InfrequentAccess"; const amount=number(r,"requests");
      const price=CLASS_A.has(action)?(ia?9:4.5)*1e-6:CLASS_B.has(action)?(ia?0.9:0.36)*1e-6:FREE.has(action)?0:undefined;
      if (price===undefined) throw new Error("Unmapped R2 billing operation");
      const p=[metric("R2",r.dimensions.bucketName,`对象存储 ${action} (${r.dimensions.storageClass})`,amount,amount,"operations",price,`${action}:${r.dimensions.storageClass}`)];
      if(ia && action==="GetObject") p.push(metric("R2",r.dimensions.bucketName,"低频存储数据检索",number(r,"responseObjectSize"),amount,"bytes",0.01/1e9,"retrieval"));
      return p;
    })},
    {product:"KV",name:"KV",selection:`kvOperationsAdaptiveGroups(limit:${LIMIT},${filter}){dimensions{namespaceId actionType} sum{requests}}`,convert:rows=>rows.map(r=>{
      const action=r.dimensions.actionType; const price=action==="read"?0.5e-6:["write","delete","list"].includes(action)?5e-6:undefined;
      if(price===undefined) throw new Error("Unmapped KV billing operation");
      return metric("KV",r.dimensions.namespaceId,`KV ${action}`,number(r,"requests"),number(r,"requests"),"operations",price,action);
    })},
    {product:"DO",name:"DO",selection:`durableObjectsPeriodicGroups(limit:${LIMIT},${filter}){dimensions{namespaceId} sum{rowsRead rowsWritten}}`,convert:rows=>rows.flatMap(r=>[metric("DO",r.dimensions.namespaceId,"DO SQL 读取",number(r,"rowsRead"),0,"rows",1e-9,"read"),metric("DO",r.dimensions.namespaceId,"DO SQL 写入",number(r,"rowsWritten"),0,"rows",1e-6,"write")])},
    {product:"Queues",name:"Queues",selection:`queueMessageOperationsAdaptiveGroups(limit:${LIMIT},${filter}){dimensions{queueId} sum{billableOperations}}`,convert:rows=>rows.map(r=>metric("Queues",r.dimensions.queueId,"队列计费操作",number(r,"billableOperations"),number(r,"billableOperations"),"operations",0.4e-6,"operations"))},
  ];
  // Fixed six calls, not one call per user/resource. Partial failures never imply zero usage.
  const outcomes = await Promise.all(sources.map(async source=>{
    try {const rows=await graphql(config,source.selection,fetcher); return {source,points:await source.convert(rows)};}
    catch (error) { return {source,error:`${source.name}: ${unavailable(error)}`}; }
  }));
  for(const o of outcomes) {if(o.error)frame.errors.push(o.error);else {frame.points.push(...o.points!);frame.healthy.push(o.source.product);}}
  // Query insights are a bounded diagnostic breakdown, not additional billable usage.
  try {
    const selection=`d1QueriesAdaptiveGroups(limit:${LIMIT},${filter},orderBy:[sum_rowsRead_DESC]){count dimensions{databaseId query} sum{rowsRead rowsWritten rowsReturned}}`;
    const rows=await graphql(config,selection,fetcher);
    const grouped=new Map<string,Point>();
    for(const r of rows) {
      const id=await fingerprint(r.dimensions.query),ops=r.count??0,reads=number(r,"rowsRead"),writes=number(r,"rowsWritten");
      for(const [suffix,amount,price,warn,critical] of [["read",reads,1e-9,50_000,200_000],["write",writes,1e-6,500,5000]] as const) {
        if(!amount) continue;
        const point=metric("D1",r.dimensions.databaseId,`SQL 指纹 ${id} ${suffix}`,amount,ops,"rows",price,`sql-${id}-${suffix}`,{diagnostic:true,efficiencyWarning:warn,efficiencyCritical:critical,minAmount:suffix==="read"?100_000:1000});
        const existing=grouped.get(point.key); if(existing){existing.amount+=amount;existing.operations+=ops;existing.usd+=point.usd;}else grouped.set(point.key,point);
      }
    }
    for(const p of grouped.values()) {p.efficiency=p.operations?p.amount/p.operations:0;frame.points.push(p);}
    frame.completeQueries=true;
  } catch (error) {frame.diagnostics!.push(`D1 SQL: ${unavailable(error)}`);}
  // Storage snapshots have a lower, irregular cadence than operation counters and
  // a single snapshot can land late. Look back STORAGE_LOOKBACK_MS and keep the
  // latest snapshot per bucket/storage class, so one delayed snapshot does not
  // mark coverage incomplete. A known gauge with no snapshot in the whole
  // lookback still does (see evaluate()); absence never becomes zero.
  try {
    const storageFilter=`filter:{datetime_geq:${JSON.stringify(new Date(end-STORAGE_LOOKBACK_MS).toISOString())},datetime_lt:${JSON.stringify(new Date(end).toISOString())}}`;
    const rows=await graphql(config,`r2StorageAdaptiveGroups(limit:${LIMIT},${storageFilter},orderBy:[datetime_DESC]){dimensions{datetime bucketName storageClass} max{payloadSize metadataSize}}`,fetcher);
    const latest=new Map<string,{at:number;row:Row}>();
    for(const r of rows){
      const at=Date.parse(r.dimensions.datetime);
      if(!Number.isFinite(at))throw new Error("Invalid storage snapshot time");
      const id=JSON.stringify([r.dimensions.bucketName,r.dimensions.storageClass]),seen=latest.get(id);
      if(!seen||at>seen.at)latest.set(id,{at,row:r});
    }
    for(const {row:r} of latest.values()){const bytes=number(r,"payloadSize","max")+number(r,"metadataSize","max"),ia=r.dimensions.storageClass==="InfrequentAccess";frame.points.push(metric("R2",r.dimensions.bucketName,`存储量（近三小时最新快照，${r.dimensions.storageClass}）`,bytes,1,"bytes",(ia?0.01:0.015)/1e9/30/24/12,`storage:${r.dimensions.storageClass}`,{gauge:true,minAmount:1e9,efficiencyWarning:1e12,efficiencyCritical:5e12}));}
  } catch (error) {frame.errors.push(`R2 storage: ${unavailable(error)}`);}
  const workerRequests=frame.points.filter(p=>p.product==="Workers" && p.key.endsWith(":requests")).reduce((s,p)=>s+p.amount,0);
  for(const p of frame.points)if(["R2","KV","DO","Queues"].includes(p.product) && !p.gauge){
    p.relative=workerRequests>0 && frame.healthy.includes("Workers");
    if(p.relative){p.efficiency=p.amount/workerRequests;p.operations=workerRequests;p.denominator="账户 Worker 调用（归一化参考）";}
  }
  frame.costComplete = frame.errors.length === 0 && sources.every(source => frame.healthy.includes(source.product));
  // A large query-fingerprint breakdown must not discard the six core sources.
  // Keep the most expensive bounded diagnostics; an incomplete breakdown cannot
  // establish that a missing fingerprint recovered.
  const core = frame.points.filter(p => !p.diagnostic);
  const diagnostics = frame.points.filter(p => p.diagnostic).sort((a, b) => b.usd - a.usd);
  // The caller still appends bounded service probes, business counters and billing.
  frame.points = [...core, ...diagnostics.slice(0, Math.max(0, Math.min(48, MAX_POINTS - 16 - core.length)))];
  const truncated = () => {
    frame.completeQueries = false;
    const message = "D1 SQL: diagnostic breakdown limited; core usage remains covered";
    if (!frame.diagnostics!.includes(message)) frame.diagnostics!.push(message);
  };
  if (frame.points.length - core.length < diagnostics.length) truncated();
  while (frame.points.length > core.length && new TextEncoder().encode(JSON.stringify(frame)).byteLength > MAX_WINDOW_BYTES - 8 * 1024) {
    frame.points.pop(); truncated();
  }
  return frame;
}
export async function billable(config: CollectorConfig, now = Date.now(), fetcher = fetch): Promise<Point[]> {
  const response=await fetcher(`https://api.cloudflare.com/client/v4/accounts/${config.account}/billable-usage`,{headers:{authorization:`Bearer ${config.token}`},signal:AbortSignal.timeout(20_000)});
  const payload=object(await boundedJson(response));
  if(payload.success!==true || !Array.isArray(payload.result) || payload.result.length>5000) throw new Error("Billing reconciliation unavailable");
  const daily=new Map<string,Map<string,number>>();
  for(const value of payload.result){const r=object(value);const start=Date.parse(String(r.ChargePeriodStart)),end=Date.parse(String(r.ChargePeriodEnd));
    if(!Number.isFinite(start)||!Number.isFinite(end)||end>now-3600_000||end<now-7*86400_000||r.BillingCurrency!=="USD")continue;
    const service=String(r.ServiceName).slice(0,100),cost=r.EffectiveCost;
    if(typeof cost!=="number"||!Number.isFinite(cost)||cost<0)throw new Error("Invalid billable cost");
    const key=new Date(start).toISOString().slice(0,10);const services=daily.get(key)??new Map<string,number>();services.set(service,(services.get(service)??0)+cost);daily.set(key,services);
  }
  const latest=[...daily.keys()].sort().at(-1);
  if(!latest)throw new Error("No recent closed billing day");
  const services=daily.get(latest)!;const total=[...services.values()].reduce((a,b)=>a+b,0);
  const top=[...services].sort((a,b)=>b[1]-a[1]).slice(0,3).map(([n,c])=>`${n}: $${c.toFixed(2)}`).join("; ");
  return [metric("Billing",latest,`已上报日费用；${top}`.slice(0,120),total,1,"USD/day",0,"daily",{gauge:true,key:"Billing:account:daily"})];
}

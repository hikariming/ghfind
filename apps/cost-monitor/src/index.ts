import { DurableObject } from "cloudflare:workers";
import { acknowledge, compact, DEFAULT_RULES, emptyState, evaluate, HISTORY_TTL_MS, MAX_STATE_BYTES, MAX_WINDOWS, MAX_WINDOW_BYTES, recipients, STATE_TTL_MS, WINDOW_MS, type Frame, type State } from "./engine";
import { billable, collect } from "./metrics";
interface MonitorEnv extends Env {
  CF_MONITOR_API_TOKEN: string;
  MONITOR_ADMIN_TOKEN: string;
  ALERT_RECIPIENTS: string;
  E2E_ENABLED?: string;
  E2E_CAPTURE_MAIL?: string;
}
const TITLES = { open:"异常告警", reminder:"异常持续提醒", escalation:"异常升级", recovery:"恢复通知" };
const json = (value: unknown, status = 200) => Response.json(value,{status,headers:{"cache-control":"no-store"}});
export class CostMonitor extends DurableObject<MonitorEnv> {
  constructor(ctx: DurableObjectState, env: MonitorEnv) {
    super(ctx,env);
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS monitor_state (id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL, expires_at INTEGER NOT NULL)");
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS windows (at INTEGER PRIMARY KEY, data TEXT NOT NULL, expires_at INTEGER NOT NULL)");
    ctx.storage.sql.exec("CREATE INDEX IF NOT EXISTS windows_expiry ON windows(expires_at)");
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS lease (id INTEGER PRIMARY KEY CHECK(id=1), owner TEXT NOT NULL, expires_at INTEGER NOT NULL)");
  }
  private load(now=Date.now()): State {
    const row=this.ctx.storage.sql.exec<{data:string}>("SELECT data FROM monitor_state WHERE id=1 AND expires_at>?",now).toArray()[0];
    return row ? JSON.parse(row.data) as State : emptyState();
  }
  private save(state:State,now:number): void {
    compact(state,now);
    const data=JSON.stringify(state);
    if(new TextEncoder().encode(data).byteLength>MAX_STATE_BYTES)throw new Error("Monitor state exceeds storage bound");
    this.ctx.storage.sql.exec("INSERT INTO monitor_state VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data,expires_at=excluded.expires_at",data,now+STATE_TTL_MS);
  }
  private prune(now:number):void {
    this.ctx.storage.sql.exec("DELETE FROM windows WHERE expires_at<=?",now);
    this.ctx.storage.sql.exec("DELETE FROM windows WHERE at < COALESCE((SELECT at FROM windows ORDER BY at DESC LIMIT 1 OFFSET ?),-1)",MAX_WINDOWS-1);
    this.ctx.storage.sql.exec("DELETE FROM monitor_state WHERE expires_at<=?",now);
    this.ctx.storage.sql.exec("DELETE FROM lease WHERE expires_at<=?",now);
  }
  private lease(now:number): string | null {
    return this.ctx.storage.transactionSync(()=>{
      const old=this.ctx.storage.sql.exec<{expires_at:number}>("SELECT expires_at FROM lease WHERE id=1").toArray()[0];
      if(old && old.expires_at>now)return null;
      const owner=crypto.randomUUID();
      this.ctx.storage.sql.exec("INSERT INTO lease VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET owner=excluded.owner,expires_at=excluded.expires_at",owner,now+10*60_000);
      return owner;
    });
  }
  private storeFrame(frame:Frame, now:number):void {
    const data=JSON.stringify(frame);
    if(new TextEncoder().encode(data).byteLength>MAX_WINDOW_BYTES)throw new Error("Monitor window exceeds storage bound");
    this.ctx.storage.transactionSync(()=>{
      this.ctx.storage.sql.exec("INSERT INTO windows VALUES(?,?,?) ON CONFLICT(at) DO UPDATE SET data=excluded.data,expires_at=excluded.expires_at",frame.at,data,now+HISTORY_TTL_MS);
      this.ctx.storage.sql.exec("DELETE FROM windows WHERE at < COALESCE((SELECT at FROM windows ORDER BY at DESC LIMIT 1 OFFSET ?),-1)",MAX_WINDOWS-1);
    });
  }
  private collectionFailure(state:State,now:number):void {
    const key="Monitor:collection:health";
    if(state.outbox.some(n=>n.key===key)||state.outbox.length>=16)return;
    const last=state.recentDelivery.filter(d=>d.id.startsWith(key)).at(-1);
    if(last && now-last.at<30*60_000)return;
    state.outbox.push({id:`${key}:${Math.floor(now/(30*60_000))}`,key,kind:"open",severity:2,text:`Cloudflare 用量采集未完成或数据尚未上报。不能确认账单安全。\n状态：${state.lastError??"采集不完整"}\n请检查 API Token 权限、数据延迟、指标映射与监控运行状态。`,delivered:[],attempts:0,expiresAt:now+STATE_TTL_MS});
  }
  private async deliver(state:State,now:number,failSecond=false):Promise<void> {
    if(!state.outbox.length)return;
    const targets=recipients(this.env.ALERT_RECIPIENTS);
    // One aggregated message per recipient per tick, not one email per metric/user.
    for(const to of targets){
      const pending=state.outbox.filter(n=>!n.delivered.includes(to));
      if(!pending.length)continue;
      const subject=`[ghfind${this.env.E2E_ENABLED==="1"?" E2E 演练":""}] ${pending.some(n=>n.severity>=2)?"严重 ":""}${TITLES[pending[0].kind]}（${pending.length} 项）`;
      const text=[this.env.E2E_ENABLED==="1"?"这是告警链路演练，包含模拟异常，不代表生产数据库发生事故。":"这是自动用量监控通知。",...pending.map(n=>`${TITLES[n.kind]}\n${n.text}`),`Cloudflare 排查入口：https://dash.cloudflare.com/${this.env.CF_ACCOUNT_ID}/billing/billable-usage`,"异常持续期间每 30 分钟提醒，连续两个有效窗口正常后通知恢复。"].join("\n\n");
      const hour=Math.floor(now/3600_000),day=Math.floor(now/86400_000);
      const budget=state.mailBudget;
      if(budget.hour!==hour){budget.hour=hour;budget.hourly=0;}
      if(budget.day!==day){budget.day=day;budget.daily=0;}
      if(budget.hourly>=8||budget.daily>=120){state.lastError="Email rate budget reached; notifications retained";this.save(state,now);break;}
      budget.hourly++;budget.daily++;this.save(state,now);
      try {
        if(failSecond && to===targets[1])throw new Error("E2E simulated transient send failure");
        let id="captured";
        if(this.env.E2E_ENABLED!=="1" || this.env.E2E_CAPTURE_MAIL!=="1") {
          const escaped=text.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
          const result=await this.env.EMAIL.send({from:{email:this.env.ALERT_FROM,name:"ghfind 用量监控"},to,subject,text,html:`<pre style="white-space:pre-wrap">${escaped}</pre>`});
          id=result.messageId;
        }
        state.mailReceipts.push({at:now,messageId:id});
        for(const n of pending){n.delivered.push(to);n.attempts++;}
        // Delivery acceptance receipt only; final delivery is checked in Email Service logs.
        console.log(JSON.stringify({event:"cost_monitor_mail_accepted",messageId:id,notices:pending.length}));
        this.save(state,now); // Partial recipient success survives later failure/restart.
      } catch {
        for(const n of pending)n.attempts++;
        state.lastError="Email delivery failed; pending recipient retained for retry";
        this.save(state,now);
        console.error(JSON.stringify({event:"cost_monitor_mail_failed"}));
      }
    }
    for(const notice of [...state.outbox])if(targets.every(to=>notice.delivered.includes(to)))acknowledge(state,notice,now);
    this.save(state,now);
  }
  async tick(): Promise<{status:string; points?:number; errors?:string[]}> {
    const now=Date.now(),owner=this.lease(now);
    if(!owner)return {status:"busy"};
    try {
      this.prune(now);
      const state=this.load(now);state.lastAttempt=now;
      const config={account:this.env.CF_ACCOUNT_ID,token:this.env.CF_MONITOR_API_TOKEN};
      let frame:Frame;
      try {
        frame=await collect(config,now);
        if(!frame.points.some(p=>p.product==="Workers" && p.amount>0))throw new Error("Closed telemetry window has no activity; ingestion may be delayed");
        if(now-state.lastBilling>=6*3600_000){
          try{frame.points.push(...await billable(config,now));state.lastBilling=now;}catch{frame.errors.push("Billing: reconciliation unavailable");}
        }
        evaluate(state,frame,now,{hourlyWarning:Number(this.env.HOURLY_WARNING_USD??DEFAULT_RULES.hourlyWarning),hourlyCritical:Number(this.env.HOURLY_CRITICAL_USD??DEFAULT_RULES.hourlyCritical),dailyWarning:Number(this.env.DAILY_WARNING_USD??DEFAULT_RULES.dailyWarning)});
        this.storeFrame(frame,now);
        if(frame.errors.length)this.collectionFailure(state,now);
      } catch {
        state.lastError="Collection failed, delayed or exceeded bounded telemetry limits";
        this.collectionFailure(state,now);
        frame={at:state.lastFrame,points:[],healthy:[],errors:[state.lastError]};
      }
      this.save(state,now);
      await this.ctx.storage.setAlarm(now+HISTORY_TTL_MS);
      await this.deliver(state,now);
      console.log(JSON.stringify({event:"cost_monitor_tick",window:frame.at,points:frame.points.length,errors:frame.errors,pending:state.outbox.length}));
      return {status:frame.errors.length?"degraded":"ok",points:frame.points.length,errors:frame.errors};
    } finally {this.ctx.storage.sql.exec("DELETE FROM lease WHERE owner=?",owner);}
  }
  async health(): Promise<unknown> {
    const now=Date.now(),state=this.load(now);
    const counts=this.ctx.storage.sql.exec<{windows:number;bytes:number}>("SELECT COUNT(*) AS windows,COALESCE(SUM(length(data)),0) AS bytes FROM windows WHERE expires_at>?",now).one();
    return {version:1,lastAttempt:state.lastAttempt,lastSuccess:state.lastSuccess,lastFrame:state.lastFrame,lastBilling:state.lastBilling,lastError:state.lastError,metrics:Object.keys(state.metrics).length,pending:state.outbox.length,deliveries:state.recentDelivery,mailReceipts:state.mailReceipts,mailBudget:state.mailBudget,...counts,bounds:{historyTtlHours:24,stateTtlDays:7,maxWindows:MAX_WINDOWS,maxWindowBytes:MAX_WINDOW_BYTES,maxStateBytes:MAX_STATE_BYTES},healthy:now-state.lastSuccess<30*60_000 && !state.lastError && !state.outbox.length};
  }
  async alarm():Promise<void> {
    const now=Date.now();this.prune(now);
    const hasState=this.ctx.storage.sql.exec<{n:number}>("SELECT COUNT(*) AS n FROM monitor_state").one().n;
    if(hasState)await this.ctx.storage.setAlarm(now+HISTORY_TTL_MS);
  }
  async exercise(phase:string):Promise<unknown> {
    if(this.env.E2E_ENABLED!=="1")throw new Error("E2E disabled");
    const owner=this.lease(Date.now());if(!owner)return {status:"busy"};
    try {
      if(phase==="reset"){this.ctx.storage.sql.exec("DELETE FROM monitor_state");this.ctx.storage.sql.exec("DELETE FROM windows");return {status:"reset"};}
      const state=this.load();const base=Math.floor(Date.now()/86400_000)*86400_000;
      const make=(i:number,efficiency:number):Frame=>({at:base+i*WINDOW_MS,healthy:["D1","Workers","R2","KV"],errors:[],points:[{key:"D1:e2e:read",product:"D1",resource:"E2E synthetic database",label:"模拟读放大",amount:efficiency*100,operations:100,unit:"rows",usd:efficiency*100*1e-9,efficiency,efficiencyWarning:50_000,efficiencyCritical:200_000,minAmount:100_000}]});
      if(phase==="baseline")for(let i=1;i<=14;i++){const f=make(i,200);evaluate(state,f,base+i*WINDOW_MS);this.storeFrame(f,Date.now());}
      else if(phase==="breach"||phase==="partial"||phase==="duplicate"){const f=make(15,380_000);evaluate(state,f,base+15*WINDOW_MS);this.storeFrame(f,Date.now());}
      else if(phase==="reminder"){const f=make(22,380_000);evaluate(state,f,base+22*WINDOW_MS);this.storeFrame(f,Date.now());}
      else if(phase==="recovery")for(let i=23;i<=24;i++){const f=make(i,200);evaluate(state,f,base+i*WINDOW_MS);this.storeFrame(f,Date.now());}
      else if(phase==="retention"){
        for(let i=0;i<MAX_WINDOWS+20;i++){const f=make(i,200);this.storeFrame(f,Date.now());}
        this.prune(Date.now());const before=this.ctx.storage.sql.exec<{n:number}>("SELECT COUNT(*) AS n FROM windows").one().n;
        this.prune(Date.now()+HISTORY_TTL_MS+1);
        const after=this.ctx.storage.sql.exec<{n:number}>("SELECT COUNT(*) AS n FROM windows").one().n;
        return {status:"retention",before,after};
      } else if(phase==="rate-limit"){
        const now=base+15*WINDOW_MS;
        state.mailBudget={hour:Math.floor(now/3600_000),hourly:8,day:Math.floor(now/86400_000),daily:120};
        state.outbox.push({id:"Monitor:e2e:rate-limit",key:"Monitor:e2e:rate-limit",kind:"open",severity:2,text:"模拟发送预算耗尽",delivered:[],attempts:0,expiresAt:Date.now()+STATE_TTL_MS});
      } else throw new Error("Unknown E2E phase");
      this.save(state,Date.now());await this.deliver(state,base+(phase==="reminder"?22:phase==="recovery"?24:15)*WINDOW_MS,phase==="partial");
      return {status:"exercised",phase,pending:state.outbox.length,deliveries:state.recentDelivery};
    } finally {this.ctx.storage.sql.exec("DELETE FROM lease WHERE owner=?",owner);}
  }
}
async function authorized(request:Request,secret:string):Promise<boolean> {
  if(!secret)return false;
  const encoder=new TextEncoder();
  const [a,b]=await Promise.all([crypto.subtle.digest("SHA-256",encoder.encode(request.headers.get("authorization")??"")),crypto.subtle.digest("SHA-256",encoder.encode(`Bearer ${secret}`))]);
  return crypto.subtle.timingSafeEqual(a,b);
}
export default {
  async scheduled(_controller,env):Promise<void> {const result=await env.MONITOR.getByName("account").tick();if(result.status==="degraded")throw new Error("Cost monitor degraded");},
  async fetch(request,env):Promise<Response> {
    if(!await authorized(request,env.MONITOR_ADMIN_TOKEN))return json({error:"Unauthorized"},401);
    const path=new URL(request.url).pathname,stub=env.MONITOR.getByName("account");
    if(path==="/health"&&request.method==="GET")return json(await stub.health());
    if(path==="/run"&&request.method==="POST")return json(await stub.tick());
    if(env.E2E_ENABLED==="1"&&request.method==="POST"&&/^\/test\/(reset|baseline|breach|partial|duplicate|reminder|recovery|retention|rate-limit)$/.test(path))return json(await stub.exercise(path.split("/").at(-1)!));
    return json({error:"Not found"},404);
  },
} satisfies ExportedHandler<MonitorEnv>;

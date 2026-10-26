import { DurableObject } from "cloudflare:workers";
import { acknowledge, compact, DEFAULT_RULES, emptyState, evaluate, HISTORY_TTL_MS, MAX_METRICS, MAX_STATE_BYTES, MAX_WINDOWS, MAX_WINDOW_BYTES, recipients, STATE_TTL_MS, WINDOW_MS, type Frame, type Rules, type State } from "./engine";
import { dailySlot, DIGEST_MS, discardInternalMail, selectMail } from "./mail-policy";
import { renderDailyDigest, renderMail } from "./mail";
import { billingDue, internalDiagnostics, observeCollection } from "./collection-health";
import { billable, collect } from "./metrics";
import { businessPoints, probe, ROAST_FAILURE_LOOKBACK_WINDOWS, summarize, type BusinessCount } from "./business";
import { collectTraffic, type TrafficReport } from "./traffic-metrics";
import { renderTrafficReport } from "./traffic-report";
import { trafficDue, trafficComplete } from "./traffic-schedule";
interface MonitorEnv extends Env {
  CF_ZONE_ID?: string;
  TRAFFIC_REPORT_RECIPIENTS?: string;
  TRAFFIC_HOST?: string;
  CF_MONITOR_API_TOKEN: string;
  MONITOR_ADMIN_TOKEN: string;
  ALERT_RECIPIENTS: string;
  PROBE_GITHUB_LOGIN?: string;
  E2E_ENABLED?: string;
  E2E_CAPTURE_MAIL?: string;
}
const json = (value: unknown, status = 200) => Response.json(value,{status,headers:{"cache-control":"no-store"}});
const FRAME_STATE_BYTES=MAX_STATE_BYTES-16*1024;
const DELIVERY_STATE_BYTES=MAX_STATE_BYTES-8*1024;
export class CostMonitor extends DurableObject<MonitorEnv> {
  constructor(ctx: DurableObjectState, env: MonitorEnv) {
    super(ctx,env);
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS monitor_state (id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL, expires_at INTEGER NOT NULL)");
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS windows (at INTEGER PRIMARY KEY, data TEXT NOT NULL, expires_at INTEGER NOT NULL)");
    ctx.storage.sql.exec("CREATE INDEX IF NOT EXISTS windows_expiry ON windows(expires_at)");
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS business_windows (at INTEGER NOT NULL,feature TEXT NOT NULL,total INTEGER NOT NULL,failed INTEGER NOT NULL,slow INTEGER NOT NULL,PRIMARY KEY(at,feature))");
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS lease (id INTEGER PRIMARY KEY CHECK(id=1), owner TEXT NOT NULL, expires_at INTEGER NOT NULL)");
  }
  async recordBusiness(rows:BusinessCount[]):Promise<void> {
    const now=Date.now();
    this.ctx.storage.sql.exec("DELETE FROM business_windows WHERE at<?",now-HISTORY_TTL_MS);
    for(const r of rows.slice(0,192)) {
      if(r.at<now-HISTORY_TTL_MS || r.at>now+WINDOW_MS)continue;
      this.ctx.storage.sql.exec("INSERT INTO business_windows VALUES(?,?,?,?,?) ON CONFLICT(at,feature) DO UPDATE SET total=total+excluded.total,failed=failed+excluded.failed,slow=slow+excluded.slow",r.at,r.feature,r.total,r.failed,r.slow);
    }
  }
  private load(now=Date.now()): State {
    const row=this.ctx.storage.sql.exec<{data:string}>("SELECT data FROM monitor_state WHERE id=1 AND expires_at>?",now).toArray()[0];
    return row ? JSON.parse(row.data) as State : emptyState();
  }
  private encodeState(state:State,now:number,limit=MAX_STATE_BYTES):string {
    compact(state,now);
    const data=JSON.stringify(state);
    if(new TextEncoder().encode(data).byteLength>limit)throw new Error("Monitor state exceeds storage bound");
    return data;
  }
  private save(state:State,now:number,limit=MAX_STATE_BYTES): void {
    const data=this.encodeState(state,now,limit);
    this.ctx.storage.sql.exec("INSERT INTO monitor_state VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data,expires_at=excluded.expires_at",data,now+STATE_TTL_MS);
  }
  private prune(now:number):void {
    this.ctx.storage.sql.exec("DELETE FROM business_windows WHERE at<?",now-HISTORY_TTL_MS);
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
  private storeFrame(frame:Frame, now:number, commit?:()=>void):void {
    const data=JSON.stringify(frame);
    if(new TextEncoder().encode(data).byteLength>MAX_WINDOW_BYTES)throw new Error("Monitor window exceeds storage bound");
    this.ctx.storage.transactionSync(()=>{
      this.ctx.storage.sql.exec("INSERT INTO windows VALUES(?,?,?) ON CONFLICT(at) DO UPDATE SET data=excluded.data,expires_at=excluded.expires_at",frame.at,data,now+HISTORY_TTL_MS);
      this.ctx.storage.sql.exec("DELETE FROM windows WHERE at < COALESCE((SELECT at FROM windows ORDER BY at DESC LIMIT 1 OFFSET ?),-1)",MAX_WINDOWS-1);
      commit?.();
    });
  }
  private acceptFrame(state:State,frame:Frame,now:number,rules:Rules=DEFAULT_RULES,billingCollected=false):void {
    // Evaluate privately so a late cardinality/storage failure cannot partially
    // advance baselines, notification state or successful billing freshness.
    const candidate=structuredClone(state);
    evaluate(candidate,frame,now,rules);
    if(billingCollected)candidate.lastBilling=now;
    // The candidate size check and both SQL writes share one transaction. A
    // rejected state must not leave an accepted observation behind.
    this.storeFrame(frame,now,()=>this.save(candidate,now,FRAME_STATE_BYTES));
    Object.assign(state,candidate);
  }
  private recordAcceptance(state:State,ids:Set<string>,to:string,now:number,digestDue:boolean,id:string):void {
    if(digestDue && !state.digestRecipients?.includes(to)){
      state.digestRecipients??=[];state.digestRecipients.push(to);
    }
    state.mailReceipts.push({at:now,messageId:id.slice(0,256)});
    for(const notice of state.outbox)if(ids.has(notice.id)){notice.delivered.push(to);notice.attempts++;}
  }
  private async deliver(state:State,now:number,failSecond=false,immediateExercise=false):Promise<void> {
    // Retire persisted/partially delivered operator diagnostics before checking
    // recipient configuration, budgets or retrying any delivery.
    discardInternalMail(state);
    state.nextDaily??=dailySlot(now)+86400_000;
    const dailyDue=now>=state.nextDaily;
    if(!state.outbox.length&&!dailyDue){state.lastDeliveryError=null;this.save(state,now);return;}
    const targets=recipients(this.env.ALERT_RECIPIENTS);
    if(!state.nextDigest){state.nextDigest=(Math.floor(now/DIGEST_MS)+1)*DIGEST_MS;state.digestRecipients=[];this.save(state,now);}
    if(immediateExercise && this.env.E2E_ENABLED==="1")state.nextDigest=now;
    const digestDue=now>=state.nextDigest||dailyDue;
    let attempted=false,failed=false;
    // One aggregated message per recipient per tick, not one email per metric/user.
    for(const to of targets){
      const sendDaily=dailyDue&&!state.dailyRecipients?.includes(to);
      const pending=selectMail(state.outbox.filter(n=>!n.delivered.includes(to)),now,
        sendDaily?now:state.digestRecipients?.includes(to)?now+DIGEST_MS:state.nextDigest);
      if(!pending.length&&!sendDaily)continue;
      const message=sendDaily?renderDailyDigest(state,now,{accountId:this.env.CF_ACCOUNT_ID,exercise:this.env.E2E_ENABLED==="1"}):renderMail(pending,{accountId:this.env.CF_ACCOUNT_ID,now,exercise:this.env.E2E_ENABLED==="1",digest:digestDue});
      const hour=Math.floor(now/3600_000),day=Math.floor(now/86400_000);
      const budget=state.mailBudget;
      if(budget.hour!==hour){budget.hour=hour;budget.hourly=0;}
      if(budget.day!==day){budget.day=day;budget.daily=0;}
      if(budget.hourly>=8||budget.daily>=120){state.lastDeliveryError="Email rate budget reached; notifications retained";failed=true;this.save(state,now);break;}
      const ids=new Set(pending.map(notice=>notice.id));
      try{
        const candidate=structuredClone(state);
        this.recordAcceptance(candidate,ids,to,now,digestDue,"x".repeat(256));
        if(sendDaily)candidate.dailyRecipients=[...(candidate.dailyRecipients??[]),to];
        this.encodeState(candidate,now,DELIVERY_STATE_BYTES);
      }catch{
        state.lastDeliveryError="Email receipt capacity reached; notifications retained";
        failed=true;this.save(state,now);break;
      }
      attempted=true;
      budget.hourly++;budget.daily++;this.save(state,now);
      try {
        if(failSecond && to===targets[1])throw new Error("E2E simulated transient send failure");
        let id="captured";
        if(this.env.E2E_ENABLED!=="1" || this.env.E2E_CAPTURE_MAIL!=="1") {
          const result=await this.env.EMAIL.send({from:{email:this.env.ALERT_FROM,name:"ghfind 告警"},to,...message});
          id=result.messageId;
        }
        this.recordAcceptance(state,ids,to,now,digestDue,id);
        if(sendDaily)state.dailyRecipients=[...(state.dailyRecipients??[]),to];
        // Delivery acceptance receipt only; final delivery is checked in Email Service logs.
        console.log(JSON.stringify({event:"cost_monitor_mail_accepted",messageId:id,notices:pending.length,...(this.env.E2E_ENABLED==="1"?{subject:message.subject}:{})}));
        this.save(state,now); // Partial recipient success survives later failure/restart.
      } catch {
        for(const n of pending)n.attempts++;
        failed=true;
        state.lastDeliveryError="Email delivery failed; pending recipient retained for retry";
        this.save(state,now);
        console.error(JSON.stringify({event:"cost_monitor_mail_failed"}));
      }
    }
    if(digestDue && targets.every(to=>state.digestRecipients?.includes(to))){
      state.nextDigest=(Math.floor(now/DIGEST_MS)+1)*DIGEST_MS;state.digestRecipients=[];
    }
    if(dailyDue&&targets.every(to=>state.dailyRecipients?.includes(to))){state.nextDaily=dailySlot(now)+86400_000;state.dailyRecipients=[];}
    for(const notice of [...state.outbox])if(targets.every(to=>notice.delivered.includes(to)))acknowledge(state,notice,now);
    if(!failed && (!state.outbox.length || (attempted && !state.outbox.some(n=>n.attempts>0 && targets.some(to=>!n.delivered.includes(to))))))state.lastDeliveryError=null;
    this.save(state,now);
  }
  private trafficData() {
    return collectTraffic({account:this.env.CF_ACCOUNT_ID,token:this.env.CF_MONITOR_API_TOKEN,zone:this.env.CF_ZONE_ID,host:this.env.TRAFFIC_HOST,db:this.env.TRAFFIC_DB});
  }
  async trafficPreview():Promise<string> {return renderTrafficReport(await this.trafficData()).html;}
  private async deliverTraffic(state:State,now:number,exerciseReport?:TrafficReport,failSecond=false):Promise<void> {
    if(!trafficDue(state,now)){this.save(state,now);return;}
    const targets=recipients(this.env.TRAFFIC_REPORT_RECIPIENTS||this.env.ALERT_RECIPIENTS);
    this.save(state,now);
    if(!targets.length){state.lastTrafficError="Traffic recipients missing";this.save(state,now);return;}
    if(targets.every(to=>state.trafficRecipients?.includes(to))){trafficComplete(state,now);this.save(state,now);return;}
    try {
      const message=renderTrafficReport(exerciseReport&&this.env.E2E_ENABLED==="1"?exerciseReport:await this.trafficData());
      for(const to of targets){
        if(state.trafficRecipients?.includes(to))continue;
        // Independent of alert quotas; still account for each provider attempt.
        const candidate=structuredClone(state);
        candidate.trafficRecipients=[...(candidate.trafficRecipients??[]),to];
        candidate.mailReceipts.push({at:now,messageId:"x".repeat(256)});
        this.encodeState(candidate,now,DELIVERY_STATE_BYTES);
        const hour=Math.floor(now/3600_000),day=Math.floor(now/86400_000);
        if(state.mailBudget.hour!==hour){state.mailBudget.hour=hour;state.mailBudget.hourly=0;}
        if(state.mailBudget.day!==day){state.mailBudget.day=day;state.mailBudget.daily=0;}
        state.mailBudget.hourly++;state.mailBudget.daily++;this.save(state,now);
        if(failSecond&&this.env.E2E_ENABLED==="1"&&to===targets[1])throw new Error("E2E traffic send failure");
        const result=this.env.E2E_ENABLED==="1"&&this.env.E2E_CAPTURE_MAIL==="1"?{messageId:"traffic-captured"}:await this.env.EMAIL.send({from:{email:this.env.ALERT_FROM,name:"ghfind 流量日报"},to,...message,subject:this.env.E2E_ENABLED==="1"?message.subject.replace("[ghfind]","[ghfind][模拟]"):message.subject});
        state.trafficRecipients=[...(state.trafficRecipients??[]),to];
        state.mailReceipts.push({at:now,messageId:result.messageId.slice(0,256)});
        this.save(state,now);
        console.log(JSON.stringify({event:"traffic_report_accepted",messageId:result.messageId}));
      }
      trafficComplete(state,now);
    }catch{state.lastTrafficError="Traffic report collection or delivery failed; retry pending recipients";}
    this.save(state,now);
  }
  async tick(): Promise<{status:string; points?:number; errors?:string[]}> {
    const now=Date.now(),owner=this.lease(now);
    if(!owner)return {status:"busy"};
    try {
      this.prune(now);
      const state=this.load(now);state.lastAttempt=now;this.save(state,now);
      const config={account:this.env.CF_ACCOUNT_ID,token:this.env.CF_MONITOR_API_TOKEN};
      let frame:Frame;
      let billingCollected=false;
      try {
        frame=await collect(config,now);
        await this.recordBusiness([]);
        const business=this.ctx.storage.sql.exec<BusinessCount & Record<string,SqlStorageValue>>("SELECT * FROM business_windows WHERE at=?",frame.at).toArray();
        // Roast failures are judged over a rolling lookback (see business.ts).
        const recent=this.ctx.storage.sql.exec<BusinessCount & Record<string,SqlStorageValue>>("SELECT * FROM business_windows WHERE at>? AND at<=?",frame.at-ROAST_FAILURE_LOOKBACK_WINDOWS*WINDOW_MS,frame.at).toArray();
        frame.points.push(...businessPoints(business,recent),...await probe(now,fetch,this.env.PROBE_GITHUB_LOGIN));
        if(billingDue(state,now)){
          state.lastBillingAttempt=now;
          try{frame.points.push(...await billable(config,now));billingCollected=true;state.lastBillingError=null;}catch{state.lastBillingError="Billing: reconciliation unavailable";}
        }
        if(state.lastBillingError)frame.errors.push(state.lastBillingError);
        this.acceptFrame(state,frame,now,{hourlyWarning:Number(this.env.HOURLY_WARNING_USD??DEFAULT_RULES.hourlyWarning),hourlyCritical:Number(this.env.HOURLY_CRITICAL_USD??DEFAULT_RULES.hourlyCritical),dailyWarning:Number(this.env.DAILY_WARNING_USD??DEFAULT_RULES.dailyWarning)},billingCollected);
      } catch (error) {
        // The reason is a fixed internal message (limits, ingestion delay, API
        // shape), never credentials; log it so a stuck monitor is diagnosable.
        console.error(JSON.stringify({event:"cost_monitor_collection_failed",reason:error instanceof Error?error.message.slice(0,200):"unknown"}));
        state.lastError="Monitor: collection could not be completed; inspect the bounded collector logs";
        frame={at:state.lastFrame,points:[],healthy:[],errors:[state.lastError]};
      }
      observeCollection(state,frame.errors,now,frame.at);
      this.save(state,now);
      await this.ctx.storage.setAlarm(now+HISTORY_TTL_MS);
      await this.deliver(state,now);
      await this.deliverTraffic(state,now);
      state.lastCompletedAt=now;this.save(state,now);
      console.log(JSON.stringify({event:"cost_monitor_tick",window:frame.at,points:frame.points.length,errors:frame.errors,pending:state.outbox.length}));
      return {status:frame.errors.length?"degraded":"ok",points:frame.points.length,errors:frame.errors};
    } finally {this.ctx.storage.sql.exec("DELETE FROM lease WHERE owner=?",owner);}
  }
  async health(): Promise<unknown> {
    const now=Date.now(),state=this.load(now);
    const counts=this.ctx.storage.sql.exec<{windows:number;bytes:number}>("SELECT COUNT(*) AS windows,COALESCE(SUM(length(data)),0) AS bytes FROM windows WHERE expires_at>?",now).one();
    const completed=state.lastCompletedAt??state.lastAttempt;
    const heartbeatHealthy=completed>0 && completed<=now+60_000 && now-completed<30*60_000;
    const collectionHealthy=state.lastSuccess>0 && now-state.lastSuccess<30*60_000 && !state.lastError;
    const deliveryHealthy=!state.lastDeliveryError;
    const collection=state.collection?{since:state.collection.since,lastFailureWindow:state.collection.lastFailureWindow,lastSuccessWindow:state.collection.lastSuccessWindow,failures:state.collection.failures,good:state.collection.good,lastCompleteAt:state.collection.lastCompleteAt,reason:state.collection.reason}:null;
    return {version:2,nextTrafficReport:state.nextTrafficReport,lastTrafficReportAt:state.lastTrafficReportAt,lastTrafficError:state.lastTrafficError??null,probeAccountConfigured:/^[a-zA-Z0-9-]{1,39}$/.test(this.env.PROBE_GITHUB_LOGIN??""),probeAccountStatus:/^[a-zA-Z0-9-]{1,39}$/.test(this.env.PROBE_GITHUB_LOGIN??"")?"enabled":"skipped: PROBE_GITHUB_LOGIN missing or invalid",nextDaily:state.nextDaily,lastAttempt:state.lastAttempt,lastCompletedAt:completed,lastSuccess:state.lastSuccess,lastFrame:state.lastFrame,lastBilling:state.lastBilling,lastBillingAttempt:state.lastBillingAttempt??0,lastBillingError:state.lastBillingError??null,lastError:state.lastError,lastDeliveryError:state.lastDeliveryError??null,collection,internalDiagnostics:internalDiagnostics(state,now),metrics:Object.keys(state.metrics).length,pending:state.outbox.length,deliveries:state.recentDelivery,mailReceipts:state.mailReceipts,mailBudget:state.mailBudget,...counts,bounds:{historyTtlHours:24,stateTtlDays:7,maxWindows:MAX_WINDOWS,maxWindowBytes:MAX_WINDOW_BYTES,maxStateBytes:MAX_STATE_BYTES},heartbeatHealthy,collectionHealthy,deliveryHealthy,healthy:heartbeatHealthy&&collectionHealthy&&deliveryHealthy};
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
      if(phase==="reset"){this.ctx.storage.sql.exec("DELETE FROM monitor_state");this.ctx.storage.sql.exec("DELETE FROM windows");this.ctx.storage.sql.exec("DELETE FROM business_windows");return {status:"reset"};}
      const state=this.load();const base=Math.floor(Date.now()/86400_000)*86400_000;
      state.nextDaily=base+2*86400_000;
      const make=(i:number,efficiency:number):Frame=>({at:base+i*WINDOW_MS,healthy:["D1","Workers","R2","KV","DO","Queues"],errors:[],points:[{key:"Service:scan:errors",product:"Service",resource:"E2E synthetic Worker",label:"模拟 Worker 请求失败",amount:efficiency*100,operations:100,unit:"errors",usd:0,efficiency,efficiencyWarning:0.01,efficiencyCritical:0.05,minAmount:3,relative:false}]});
      if(phase==="traffic"){
        const s=emptyState(),report:TrafficReport={generatedAt:base,end:base,visitorSource:"模拟浏览器访问",metrics:[{key:"visitors",label:"访客",values:[1,3,7].map(n=>({current:20*n,previous:10*n}))}],days:[],paths:[],countries:[],referrers:[],notes:["模拟数据"]};
        await this.deliverTraffic(s,base+3*3600_000,report);const before=s.mailReceipts.length;
        s.mailBudget={hour:Math.floor((base+4*3600_000)/3600_000),day:Math.floor(base/86400_000),hourly:8,daily:120};
        await this.deliverTraffic(s,base+4*3600_000,report,true);const partial=s.mailReceipts.length,failed=!!s.lastTrafficError;
        const persisted=this.load(base+4*3600_000);
        await this.deliverTraffic(persisted,base+4*3600_000+300000,report);const retry=persisted.mailReceipts.length,attempts=persisted.mailBudget.daily;
        await this.deliverTraffic(persisted,base+5*3600_000,report);const duplicate=persisted.mailReceipts.length;
        await this.deliverTraffic(persisted,base+3*86400_000+5*3600_000,report);const missed=persisted.mailReceipts.length;
        await this.deliverTraffic(persisted,base+3*86400_000+6*3600_000,report);
        return {before,partial,failed,retry,attempts,duplicate,missed,after:persisted.mailReceipts.length,next:persisted.nextTrafficReport};
      }
      if(phase==="billing"){
        const s=emptyState();s.nextDaily=base+2*86400_000;
        s.outbox.push({id:"billing-exercise",key:"account:burn",kind:"open",severity:1,startedAt:Date.now()-900000,text:"模拟计费预警",evidence:{resource:"Cloudflare 账户",metric:"估算消耗",value:"$0.60/h",threshold:"$0.50/h",window:"模拟窗口",action:"核对用量与账单"},delivered:[],attempts:0,expiresAt:Date.now()+STATE_TTL_MS});
        const subject=renderMail(s.outbox,{accountId:this.env.CF_ACCOUNT_ID,now:Date.now(),exercise:true}).subject;
        await this.deliver(s,Date.now());
        return {subject,accepted:s.mailReceipts.length,pending:s.outbox.length};
      }
      if(phase==="daily"){
        const s=emptyState();s.nextDaily=base+3600_000;
        await this.deliver(s,base+3600_000,true);
        const partial=s.mailReceipts.length;
        const failureReported=!!s.lastDeliveryError;
        let restored=this.load(base+3600_000);
        await this.deliver(restored,base+65*60_000);
        const retry=restored.mailReceipts.length;
        await this.deliver(restored,base+70*60_000);
        const duplicate=restored.mailReceipts.length;
        restored=this.load(base+70*60_000);
        const subject=renderDailyDigest(restored,base+3600_000,{exercise:true}).subject;
        return {partial,retry,duplicate,failureReported,pending:restored.outbox.length,nextDaily:restored.nextDaily,subject};
      }
      if(phase==="daily-mixed"){
        const s=emptyState();s.nextDaily=base+3600_000;s.nextDigest=base+90*60_000;
        s.outbox.push({id:"daily-slow",key:"Service:roast:slow",kind:"open",severity:1,text:"模拟慢响应",delivered:[],attempts:0,expiresAt:base+STATE_TTL_MS});
        const subject=renderDailyDigest(s,base+3600_000,{exercise:true}).subject;
        await this.deliver(s,base+3600_000);
        const accepted=s.mailReceipts.length;
        await this.deliver(s,base+95*60_000);
        return {subject,accepted,afterHourly:s.mailReceipts.length,pending:s.outbox.length};
      }
      if(phase==="hourly"){
        const s=emptyState();s.nextDaily=base+2*86400_000;const notice=(key:string,severity:number)=>({id:key,key,kind:"open" as const,severity,text:"hourly E2E",delivered:[],attempts:0,expiresAt:Date.now()+STATE_TTL_MS});
        s.outbox.push(notice("Service:roast:slow",1));
        await this.deliver(s,base);await this.deliver(s,base+30*60_000);
        const before=s.mailReceipts.length;
        await this.deliver(s,base+60*60_000);const digest=s.mailReceipts.length;
        s.outbox.push(notice("Service:roast:errors",2));await this.deliver(s,base+65*60_000);
        const critical=s.mailReceipts.length;
        s.outbox.push(notice("Workers:test:errors",1));await this.deliver(s,base+70*60_000);
        const quiet=s.mailReceipts.length;
        await this.deliver(s,base+120*60_000,true);const partial=s.mailReceipts.length;
        await this.deliver(s,base+125*60_000);const retry=s.mailReceipts.length;
        return {before,digest,critical,quiet,partial,retry,pending:s.outbox.length};
      }
      if(phase==="business"){
        const at=Math.floor(Date.now()/WINDOW_MS)*WINDOW_MS;
        // Two failures inside the rolling roast lookback: one in an earlier
        // window, one merged into the current window's aggregate.
        await this.recordBusiness([{at:at-WINDOW_MS,feature:"roast",total:1,failed:1,slow:0}]);
        await this.recordBusiness([{at,feature:"roast",total:2,failed:1,slow:0}]);
        await this.recordBusiness([{at,feature:"roast",total:3,failed:0,slow:1}]);
        const rows=this.ctx.storage.sql.exec<BusinessCount & Record<string,SqlStorageValue>>("SELECT * FROM business_windows WHERE at=?",at).toArray();
        const recent=this.ctx.storage.sql.exec<BusinessCount & Record<string,SqlStorageValue>>("SELECT * FROM business_windows WHERE at>? AND at<=?",at-ROAST_FAILURE_LOOKBACK_WINDOWS*WINDOW_MS,at).toArray();
        const points=businessPoints(rows,recent);
        evaluate(state,{at,points,healthy:[],errors:[]},Date.now());
        const severity=state.metrics["Service:roast:errors"].severity;
        this.prune(Date.now()+HISTORY_TTL_MS+WINDOW_MS);
        return {status:"business",rows,severity,remaining:this.ctx.storage.sql.exec<{n:number}>("SELECT COUNT(*) AS n FROM business_windows").one().n};
      }
      if(phase==="atomic"){
        const s=emptyState();s.nextDaily=base+2*86400_000;evaluate(s,make(1,0.002),base+WINDOW_MS);
        const template=s.metrics["Service:scan:errors"];
        for(let i=0;Object.keys(s.metrics).length<MAX_METRICS;i++)s.metrics[`D1:fixed:${i}`]={...template,severity:2};
        for(const metric of Object.values(s.metrics))metric.severity=2;
        const frame=make(2,0.2);frame.points.push({...frame.points[0],key:"Workers:new:errors"});
        const before=JSON.stringify(s);
        const count=()=>this.ctx.storage.sql.exec<{n:number}>("SELECT COUNT(*) AS n FROM windows").one().n;
        const rows=count();let rejected=false;
        try{this.acceptFrame(s,frame,base+2*WINDOW_MS,DEFAULT_RULES,true);}catch{rejected=true;}
        const cardinality={rejected,stateUnchanged:JSON.stringify(s)===before,windowsUnchanged:count()===rows,billingUnchanged:s.lastBilling===0};
        const bounded=emptyState();
        const point=(i:number,high=false)=>({...make(1,high?0.2:0.002).points[0],key:`Workers:${String(i).padEnd(100,"x")}:errors`,resource:String(i).padEnd(100,"x")});
        for(let i=0;i<8;i++)evaluate(bounded,{at:base+(i+1)*WINDOW_MS,points:Array.from({length:32},(_,j)=>point(i*32+j)),healthy:[],errors:[]},base+(i+1)*WINDOW_MS);
        for(let i=0;i<2;i++)evaluate(bounded,{at:base+(i+9)*WINDOW_MS,points:Array.from({length:i?31:32},(_,j)=>point(i*32+j,true)),healthy:[],errors:[]},base+(i+9)*WINDOW_MS);
        const bytes=()=>new TextEncoder().encode(JSON.stringify(bounded)).byteLength;
        // Fill legal partial-recipient receipts up to the persisted state bound.
        // One additional incident then exceeds bytes, not the metric/count caps.
        for(const notice of bounded.outbox)for(let i=0;i<19;i++){
          notice.delivered.push(`${String(i).padEnd(50,"x")}@example.org`);
          if(bytes()>FRAME_STATE_BYTES){notice.delivered.pop();break;}
        }
        this.save(bounded,base+10*WINDOW_MS);
        const storedBefore=JSON.stringify(this.load(base+10*WINDOW_MS)),memoryBefore=JSON.stringify(bounded);
        const sizeFrame={at:base+11*WINDOW_MS,points:[point(63,true)],healthy:[],errors:[]};
        let sizeRejected=false;
        try{this.acceptFrame(bounded,sizeFrame,base+11*WINDOW_MS,DEFAULT_RULES,true);}catch(error){sizeRejected=error instanceof Error&&error.message==="Monitor state exceeds storage bound";}
        const storageSize={rejected:sizeRejected,stateUnchanged:JSON.stringify(bounded)===memoryBefore,persistedStateUnchanged:JSON.stringify(this.load(base+10*WINDOW_MS))===storedBefore,windowsUnchanged:count()===rows,billingUnchanged:bounded.lastBilling===0};
        for(const notice of bounded.outbox)for(let i=notice.delivered.length;i<19;i++){
          notice.delivered.push(`${String(i).padEnd(50,"x")}@example.org`);
          if(bytes()>MAX_STATE_BYTES-4*1024){notice.delivered.pop();break;}
        }
        const pending=bounded.outbox.length;
        await this.deliver(bounded,base+11*WINDOW_MS,false,true);
        return {cardinality,storageSize,deliveryCapacity:{noSend:bounded.mailReceipts.length===0,noAttempt:bounded.mailBudget.daily===0,pendingRetained:bounded.outbox.length===pending,reported:bounded.lastDeliveryError?.includes("receipt capacity")===true}};
      }
      if(phase==="collection"){
        let s=emptyState();s.nextDaily=base+2*86400_000;
        s.lastSuccess=base-WINDOW_MS;s.lastError="D1: rate limited";
        const failure=async(minutes:number)=>{
          const at=base+minutes*60_000;
          observeCollection(s,["D1: rate limited"],at,at-3*WINDOW_MS);
          this.save(s,at);await this.deliver(s,at);
          s=this.load(at);
        };
        for(let minutes=0;minutes<=30;minutes+=5)await failure(minutes);
        const transient=s.mailReceipts.length;
        const legacy={id:"Monitor:collection:health:legacy",key:"Monitor:collection:health",kind:"open" as const,severity:2,text:"legacy collection gap",delivered:["one@example.org"],attempts:1,expiresAt:base+STATE_TTL_MS};
        s.outbox.push(legacy);s.lastDeliveryError="Email delivery failed; pending recipient retained for retry";
        Object.assign(s.collection!,{notified:true,lastNotifiedAt:base,acceptedRecipients:["one@example.org"]});
        // Delivery migrates old outboxes even without another collection run.
        await this.deliver(s,base+60*60_000);s=this.load(base+60*60_000);
        const legacyRetired=s.outbox.length===0&&!s.collection?.acceptedRecipients&&!s.lastDeliveryError;
        for(const minutes of [65,70,120,180,360,720,780,785])await failure(minutes);
        const sustained=s.mailReceipts.length;
        const stillIncomplete=s.lastSuccess===base-WINDOW_MS&&!!s.lastError&&s.collection?.since===base&&s.collection.reason==="D1: rate limited";
        s.outbox.push({...legacy,delivered:[]},{...legacy,id:"optimization",key:"D1:test:read",delivered:[]},{...legacy,id:"customer-failure",key:"Service:roast:errors",text:"Observed report failures",delivered:[]});
        await this.deliver(s,base+790*60_000);s=this.load(base+790*60_000);
        const mixed=s.mailReceipts.length,customerOnly=s.recentDelivery.length===1&&s.recentDelivery[0].id==="customer-failure";
        for(const minutes of [795,800]){
          const at=base+minutes*60_000;observeCollection(s,[],at,at-3*WINDOW_MS);
          this.save(s,at);await this.deliver(s,at);
        }
        return {transient,legacyRetired,sustained,stillIncomplete,mixed,customerOnly,recovery:s.mailReceipts.length,pending:s.outbox.length,resolved:s.collection?.since===0};
      }
      if(phase==="baseline")for(let i=1;i<=14;i++){const f=make(i,0.002);evaluate(state,f,base+i*WINDOW_MS);this.storeFrame(f,Date.now());}
      else if(phase==="breach"||phase==="partial"||phase==="duplicate"){const f=make(15,0.2);evaluate(state,f,base+15*WINDOW_MS);this.storeFrame(f,Date.now());}
      else if(phase==="reminder"){const f=make(88,0.2);evaluate(state,f,base+88*WINDOW_MS);this.storeFrame(f,Date.now());}
      else if(phase==="recovery")for(let i=89;i<=90;i++){const f=make(i,0.002);evaluate(state,f,base+i*WINDOW_MS);this.storeFrame(f,Date.now());}
      else if(phase==="retention"){
        for(let i=0;i<MAX_WINDOWS+20;i++){const f=make(i,0.002);this.storeFrame(f,Date.now());}
        this.prune(Date.now());const before=this.ctx.storage.sql.exec<{n:number}>("SELECT COUNT(*) AS n FROM windows").one().n;
        this.prune(Date.now()+HISTORY_TTL_MS+1);
        const after=this.ctx.storage.sql.exec<{n:number}>("SELECT COUNT(*) AS n FROM windows").one().n;
        return {status:"retention",before,after};
      } else if(phase==="rate-limit"){
        const now=base+15*WINDOW_MS;
        state.mailBudget={hour:Math.floor(now/3600_000),hourly:8,day:Math.floor(now/86400_000),daily:120};
        state.outbox.push({id:"Workers:e2e:rate-limit",key:"Workers:e2e:errors",kind:"open",severity:2,text:"模拟发送预算耗尽",delivered:[],attempts:0,expiresAt:Date.now()+STATE_TTL_MS});
      } else throw new Error("Unknown E2E phase");
      this.save(state,Date.now());await this.deliver(state,base+(phase==="reminder"?88:phase==="recovery"?90:15)*WINDOW_MS,phase==="partial",true);
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
  async tail(events,env):Promise<void> {
    const rows=summarize(events);
    if(rows.length)await env.MONITOR.getByName("account").recordBusiness(rows);
  },
  // Expected upstream telemetry gaps are persisted incidents, not uncaught
  // Worker failures that this same collector would ingest and alert on again.
  async scheduled(_controller,env):Promise<void> {await env.MONITOR.getByName("account").tick();},
  async fetch(request,env):Promise<Response> {
    if(!await authorized(request,env.MONITOR_ADMIN_TOKEN))return json({error:"Unauthorized"},401);
    const path=new URL(request.url).pathname,stub=env.MONITOR.getByName("account");
    if(path==="/health"&&request.method==="GET")return json(await stub.health());
    if(path==="/traffic-report/preview"&&request.method==="POST")return new Response(await stub.trafficPreview(),{headers:{"content-type":"text/html; charset=utf-8","cache-control":"no-store","content-security-policy":"default-src \'none\'; style-src \'unsafe-inline\'"}});
    if(path==="/run"&&request.method==="POST")return json(await stub.tick());
    if(env.E2E_ENABLED==="1"&&request.method==="POST"&&/^\/test\/(reset|traffic|billing|daily|daily-mixed|hourly|business|collection|atomic|baseline|breach|partial|duplicate|reminder|recovery|retention|rate-limit)$/.test(path))return json(await stub.exercise(path.split("/").at(-1)!));
    return json({error:"Not found"},404);
  },
} satisfies ExportedHandler<MonitorEnv>;

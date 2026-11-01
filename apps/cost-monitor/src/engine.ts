import type { TrafficSchedule } from "./traffic-schedule";
// Bounded, aggregated telemetry only: no user IDs, SQL text, parameters or bodies.
import { classify } from "./classify";
import { userFacing } from "./mail-policy";
export const WINDOW_MS = 5 * 60_000;
export const HISTORY_TTL_MS = 24 * 60 * 60_000;
export const STATE_TTL_MS = 7 * HISTORY_TTL_MS;
export const MAX_POINTS = 192;
export const MAX_METRICS = 256;
export const MAX_WINDOWS = 288;
export const MAX_STATE_BYTES = 192 * 1024;
export const MAX_NOTICES = 64;
export const MAX_DIAGNOSTIC_METRICS = 96;
export const MAX_WINDOW_BYTES = 48 * 1024;
export const REMINDER_MS = 6 * 60 * 60_000;
export function reminderInterval(key: string, severity=2): number { return key.startsWith("Billing:") ? HISTORY_TTL_MS : classify({key,severity}).priority===0 ? 2*3600_000 : classify({key,severity}).priority===1 ? REMINDER_MS : HISTORY_TTL_MS; }
export type Product = "D1" | "Workers" | "R2" | "KV" | "DO" | "Queues" | "Billing" | "Monitor" | "Service";
export interface Point {
  key: string;
  product: Product;
  resource: string;
  label: string;
  amount: number;
  operations: number;
  unit: string;
  // Conservative consumption at published overage rates, BEFORE included quota.
  usd: number;
  efficiency?: number;
  efficiencyWarning?: number;
  efficiencyCritical?: number;
  minAmount?: number;
  minOperations?: number;
  observedAt?: number;
  gauge?: boolean;
  denominator?: string;
  // Failure signals judged over more than the current window name that span.
  scope?: string;
  relative?: boolean;
  diagnostic?: boolean; // Per-SQL breakdown: never double count database cost.
  // Account-only partial coverage: positive cost evidence, never a full bucket.
  costLowerBound?: true;
}
export interface Frame {
  at: number;
  points: Point[];
  healthy: Product[];
  errors: string[];
  completeQueries?: boolean;
  // Optional SQL diagnostics do not determine whether consumption was collected.
  diagnostics?: string[];
  costComplete?: boolean;
}
export interface MetricState {
  baseline: number;
  samples: number;
  bad: number;
  good: number;
  severity: number;
  notifiedSeverity: number;
  lastNotified: number;
  lastP2Notified?: number;
  lastSeen: number;
  expiresAt: number;
  incident: number;
  gauge?: boolean;
  diagnostic?: boolean;
  // Account-only closed 5-minute cost buckets. Never fill missing windows with zero.
  burnWindows?: [at: number, usd: number][];
  // Keep the last evidence that actually confirmed the incident's latched level.
  evidence?: NoticeEvidence;
  trigger?: { at: number; severity: number; basis: "absolute" | "relative" | "burn" | "billing"; condition: string; observed: string };
}
export interface NoticeEvidence { startedAt?: number; resource: string; metric: string; value: string; threshold?: string; window: string; action: string; impact?: string; cost?: string }
export interface Notice { startedAt?: number; id: string; key: string; kind: "open" | "reminder" | "escalation" | "recovery"; severity: number; text: string; evidence?: NoticeEvidence; delivered: string[]; attempts: number; expiresAt: number }
export interface State extends TrafficSchedule {
  lastFrame: number;
  lastSuccess: number;
  lastAttempt: number;
  lastBilling: number;
  metrics: Record<string, MetricState>;
  outbox: Notice[];
  recentDelivery: { at: number; id: string; kind: string; recipients: number }[];
  mailReceipts: { at: number; messageId: string }[];
  mailBudget: { hour: number; hourly: number; day: number; daily: number };
  lastError: string | null;
  nextDaily?: number;
  dailyRecipients?: string[];
  recovered?: {at:number; key:string; startedAt:number; evidence?:NoticeEvidence}[];
  consumption?: [number,number][];
  latestBill?: {at:number; value:number; date:string};
  nextDigest?: number;
  digestRecipients?: string[];
  collection?: import("./collection-health").CollectionHealthState;
  lastDeliveryError?: string | null;
  lastBillingAttempt?: number;
  lastBillingError?: string | null;
  lastCompletedAt?: number;
}
export function emptyState(): State {
  return { lastFrame: 0, lastSuccess: 0, lastAttempt: 0, lastBilling: 0, metrics: {}, outbox: [], recentDelivery: [], mailReceipts: [], mailBudget: {hour:0,hourly:0,day:0,daily:0}, lastError: null };
}
export interface Rules { hourlyWarning: number; hourlyCritical: number; dailyWarning: number }
export const DEFAULT_RULES: Rules = { hourlyWarning: 0.5, hourlyCritical: 2, dailyWarning: 10 };
function burnRate(metric: MetricState, at: number, count: number): number | undefined {
  const windows = metric.burnWindows ?? [];
  if (windows.length < count || !windows.slice(-count).every(([time], i) => time === at - (count - 1 - i) * WINDOW_MS)) return undefined;
  return windows.slice(-count).reduce((sum, [, usd]) => sum + usd, 0) * 12 / count;
}
function triggerFor(p: Point, m: MetricState, at: number, rules: Rules): MetricState["trigger"] {
  const value = p.efficiency ?? p.amount;
  const make = (severity: number, condition: string, observed: string, basis: NonNullable<MetricState["trigger"]>["basis"] = "absolute") => ({ at: p.observedAt ?? at, severity, basis, condition, observed });
  if (p.key === "account:burn") {
    if (p.costLowerBound) return p.usd >= rules.hourlyCritical
      ? make(2, `单个 5 分钟已观测估算消耗 ≥ $${rules.hourlyCritical}`, `已观测至少 $${p.usd.toFixed(2)}（部分产品尚未覆盖）`, "burn") : undefined;
    const quarter = burnRate(m, at, 3), hour = burnRate(m, at, 12);
    if (p.usd >= rules.hourlyCritical) return make(2, `单个 5 分钟估算消耗 ≥ $${rules.hourlyCritical}`, `本窗 $${p.usd.toFixed(2)}`, "burn");
    if (quarter !== undefined && value >= rules.hourlyCritical && quarter >= rules.hourlyCritical) return make(2, `5 + 15 分钟均 ≥ $${rules.hourlyCritical}/h`, `5 分钟 $${value.toFixed(2)}/h；15 分钟 $${quarter.toFixed(2)}/h`, "burn");
    if (quarter !== undefined && hour !== undefined && quarter >= rules.hourlyWarning && hour >= rules.hourlyWarning) return make(1, `15 分钟 + 1 小时均 ≥ $${rules.hourlyWarning}/h`, `15 分钟 $${quarter.toFixed(2)}/h；1 小时 $${hour.toFixed(2)}/h`, "burn");
    return;
  }
  if (p.product === "Billing") {
    const severity = value >= rules.dailyWarning * 3 ? 2 : value >= rules.dailyWarning ? 1 : 0;
    if (severity) return make(severity, `日费用 ≥ $${(severity === 2 ? rules.dailyWarning * 3 : rules.dailyWarning).toFixed(2)}`, `${p.resource} 已上报 $${value.toFixed(2)}`, "billing");
    return;
  }
  const enough = (p.gauge || p.operations >= (p.minOperations ?? 20)) && p.amount >= (p.minAmount ?? 100);
  if (!enough) return;
  const ratio = m.baseline > 0 ? value / m.baseline : 0;
  for (const severity of [2, 1]) {
    const absolute = severity === 2 ? p.efficiencyCritical : p.efficiencyWarning;
    if (absolute !== undefined && value >= absolute) {
      const condition = absolute === 0 ? `观测数量 ≥ ${p.minAmount ?? 100} ${p.unit}`
        : p.key.startsWith("Service:probe-") ? "本次公开检查失败"
        : failureSignal(p) ? `${p.key.endsWith(":slow") ? "慢响应比例" : "失败率"} ≥ ${percentage(absolute)}（至少 ${p.minAmount ?? 100} 次${p.key.endsWith(":slow") ? "慢响应" : "失败"}${p.gauge ? "" : `、${p.minOperations ?? 20} 次运行`}）`
        : `${p.efficiency === undefined ? "观测值" : `每次${p.denominator ?? "操作"}`} ≥ ${absolute} ${p.unit}`;
      return make(severity, condition, observation(p));
    }
    const multiple = severity === 2 ? 10 : 3, hourly = severity === 2 ? 0.5 : 0.05;
    if (m.samples >= 12 && p.relative !== false && ratio >= multiple && p.usd * 12 >= hourly) {
      return make(severity, `相对健康基线 ≥ ${multiple} 倍，且估算用量 ≥ $${hourly}/h（至少 12 个健康样本）`, `健康基线 ${m.baseline.toFixed(2)}；当前 ${ratio.toFixed(2)} 倍，$${(p.usd * 12).toFixed(2)}/h`, "relative");
    }
  }
}
export function recipients(value: string): string[] {
  const input: unknown = JSON.parse(value);
  if (!Array.isArray(input)) throw new Error("ALERT_RECIPIENTS must be a JSON list");
  // Empty placeholders are permitted; addresses are kept in secrets, not git.
  const addresses = [...new Set(input.filter((x): x is string => typeof x === "string").map(x => x.trim().toLowerCase()).filter(Boolean))];
  if (input.some(x => typeof x !== "string") || !addresses.length || addresses.length > 20 || addresses.some(x => !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(x))) throw new Error("Invalid alert recipient list");
  return addresses;
}
export function compact(state: State, now: number): void {
  // Purge legacy operational mail before it can occupy the customer queue.
  state.outbox = state.outbox.filter(userFacing);
  for (const [key, value] of Object.entries(state.metrics)) if (value.expiresAt <= now) delete state.metrics[key];
  state.recovered=(state.recovered??[]).filter(n=>n.at>now-HISTORY_TTL_MS).slice(-64);
  state.consumption=(state.consumption??[]).filter(([at])=>at>now-HISTORY_TTL_MS).slice(-MAX_WINDOWS);
  // Migrate an old fingerprint-heavy state without letting optional query
  // diagnostics consume every slot needed by core usage and service incidents.
  const diagnostics = Object.entries(state.metrics).filter(([, m]) => m.diagnostic).sort((a, b) => b[1].lastSeen - a[1].lastSeen);
  for (const [key] of diagnostics.slice(MAX_DIAGNOSTIC_METRICS)) {
    delete state.metrics[key];
    state.outbox = state.outbox.filter(n => n.key !== key);
  }
  state.outbox = state.outbox.filter(n => n.expiresAt > now).slice(-MAX_NOTICES);
  state.mailReceipts = state.mailReceipts.filter(n => n.at > now - HISTORY_TTL_MS).slice(-12);
  state.recentDelivery = state.recentDelivery.filter(n => n.at > now - HISTORY_TTL_MS).slice(-12);
}
export function validateFrame(frame: Frame): void {
  if (!Number.isFinite(frame.at) || frame.points.length > MAX_POINTS || new TextEncoder().encode(JSON.stringify(frame)).byteLength > MAX_WINDOW_BYTES) throw new Error("Telemetry window exceeds bounds");
  const keys = new Set<string>();
  for (const p of frame.points) {
    if (keys.has(p.key) || p.key.length > 160 || p.resource.length > 100 || p.label.length > 120 || [p.amount, p.operations, p.usd, p.efficiency ?? 0].some(n => !Number.isFinite(n) || n < 0)) throw new Error("Invalid or duplicate metric");
    keys.add(p.key);
  }
}
export function evaluate(state: State, frame: Frame, now: number, rules = DEFAULT_RULES): void {
  validateFrame(frame);
  compact(state, now);
  if (frame.at < state.lastFrame) return; // Never process older windows.
  // An empty storage response does not prove a previously observed bucket is
  // free or deleted. Preserve its state until a new snapshot or the bounded
  // metric TTL; never reuse an old estimate as this window's observed cost.
  if (Object.entries(state.metrics).some(([key, metric]) => key.startsWith("R2:") && metric.gauge && !frame.points.some(point => point.key === key))) {
    frame.costComplete = false;
    // When the storage query itself failed, that error already explains the
    // gap; do not report the same failure twice.
    const reason = "R2 storage: known snapshot missing; coverage incomplete";
    if (!frame.errors.some(error => error.startsWith("R2 storage:"))) frame.errors.push(reason);
  }
  if (frame.costComplete === false && !frame.errors.length) frame.errors.push("Monitor: consumption coverage incomplete");
  if (frame.at - state.lastFrame > WINDOW_MS && state.lastFrame) {
    for (const metric of Object.values(state.metrics)) { metric.bad = 0; metric.good = 0; }
  }
  const points = [...frame.points];
  const priced = frame.points.filter(p => !p.diagnostic && p.product !== "Billing");
  const completeCost = (frame.costComplete ?? !frame.errors.length) && ["D1", "Workers", "R2", "KV", "DO", "Queues"].every(p => frame.healthy.includes(p as Product));
  const knownCost = priced.reduce((sum, point) => sum + point.usd, 0);
  if(completeCost)state.consumption=[...(state.consumption??[]).filter(([at])=>at!==frame.at),[frame.at,knownCost] as [number,number]].slice(-MAX_WINDOWS);
  const bill=frame.points.find(p=>p.key==="Billing:account:daily");
  if(bill)state.latestBill={at:frame.at,value:bill.amount,date:bill.resource};
  // Missing sources cannot establish a safe total, but already observed cost
  // above the single-window limit is sufficient positive evidence of a spike.
  if (completeCost || knownCost >= rules.hourlyCritical) points.push({ key: "account:burn", product: "Monitor", resource: "account", label: "已覆盖产品的用量消耗速度（不含外部 LLM 等费用）", amount: knownCost*12, operations: 1, unit: "USD/hour", usd: knownCost, costLowerBound: completeCost ? undefined : true });
  // Keys measured in this window; the zero points added below for vanished
  // metrics are bookkeeping and must not pin those metrics against eviction.
  const measured = new Set(points.map(p => p.key));
  const limitDiagnostic = () => {
    const message = "D1 SQL: diagnostic state limited; core usage remains covered";
    frame.diagnostics ??= [];
    if (!frame.diagnostics.includes(message)) frame.diagnostics.push(message);
    frame.completeQueries = false;
  };
  // Only a successful product collection can establish that a vanished metric is zero.
  for (const [key, previous] of Object.entries(state.metrics)) {
    const parts = key.split(":");
    const product = parts[0] as Product;
    if (!previous.gauge && (!previous.diagnostic || frame.completeQueries) && frame.healthy.includes(product) && !points.some(p => p.key === key)) {
      points.push({ key, product, resource: parts[1] ?? "resource", label: "已停止的异常用量", amount: 0, operations: 0, unit: "units", usd: 0, diagnostic: previous.diagnostic });
    }
    if (previous.expiresAt <= now) delete state.metrics[key];
  }
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    let m = state.metrics[p.key];
    if (!m) {
      if (p.diagnostic && Object.values(state.metrics).filter(v => v.diagnostic).length >= MAX_DIAGNOSTIC_METRICS) { limitDiagnostic(); continue; }
      if (Object.keys(state.metrics).length >= MAX_METRICS) {
        if (p.diagnostic) { limitDiagnostic(); continue; }
        const entries = Object.entries(state.metrics);
        const evict = entries.filter(([key,v])=>!v.severity && !v.notifiedSeverity && !v.bad && !measured.has(key)).sort((a,b)=>a[1].lastSeen-b[1].lastSeen)[0]
          ?? entries.filter(([, v]) => v.diagnostic).sort((a, b) => a[1].lastSeen - b[1].lastSeen)[0];
        if(!evict) throw new Error("Metric cardinality limit exceeded");
        if (evict[1].diagnostic) limitDiagnostic();
        delete state.metrics[evict[0]];
        state.outbox = state.outbox.filter(n => n.key !== evict[0]);
        // Drop its pending zero point too, or it would be re-created below.
        const pending = points.findIndex((q,j)=>j>i && q.key===evict[0]);
        if (pending >= 0) points.splice(pending, 1);
      }
      m = state.metrics[p.key] = { baseline: 0, samples: 0, bad: 0, good: 0, severity: 0, notifiedSeverity: 0, lastNotified: 0, lastSeen: 0, expiresAt: now + STATE_TTL_MS, incident: 0, gauge: p.gauge, diagnostic: p.diagnostic };
    }
    // A same-bucket correction after a lower-bound alert is conservatively
    // skipped too; the next complete bucket resumes history without double count.
    if (m.lastSeen === frame.at) continue; // Source correction can fill missing metrics, never train an existing one twice.
    if (m.lastSeen && frame.at-m.lastSeen>WINDOW_MS && p.product!=="Billing") {m.bad=0;m.good=0;}
    const value = p.efficiency ?? p.amount;
    const ratio = m.baseline > 0 ? value / m.baseline : 0;
    if (p.key === "account:burn" && !p.costLowerBound) {
      m.burnWindows = [...(m.burnWindows ?? []).filter(([at]) => at > frame.at - 12 * WINDOW_MS && at < frame.at), [frame.at, p.usd]];
    }
    const trigger = triggerFor(p, m, frame.at, rules);
    let level = trigger?.severity ?? 0;
    const previousSeverity=m.severity;
    if(p.key.startsWith("Service:probe-")&&level>0&&m.bad>=1){level=2;if(trigger){trigger.severity=2;trigger.condition="连续两次公开检查失败";}}
    const confirmedWindow = p.key === "account:burn" && level > 0;
    // Incomplete history cannot establish recovery while current usage is high.
    if (p.key === "account:burn" && !level && value >= rules.hourlyWarning && burnRate(m, frame.at, 12) === undefined) level = -1;
    if (level > 0) {
      m.bad++; m.good = 0;
      if (p.key.startsWith("Service:probe-") || (level === 2 && !p.diagnostic) || m.bad >= 2 || p.product === "Billing" || confirmedWindow) {
        if (!m.severity) m.incident = frame.at;
        if (trigger && level >= m.severity) m.trigger = trigger;
        m.severity = Math.max(m.severity, level);
      }
    } else if (level === 0) {
      m.bad = 0; m.good++;
      if (m.good >= 2) m.severity = 0;
      // Freeze the baseline while suspicious/active, so an incident never becomes "normal".
      if (!m.severity && m.good >= 2 && (p.operations >= 20 || p.gauge)) {
        m.baseline = m.samples ? m.baseline * 0.98 + value * 0.02 : value;
        m.samples++;
      }
    } else {
      m.bad = 0; m.good = 0;
    }
    m.lastSeen = frame.at; m.expiresAt = now + STATE_TTL_MS;
    // Recovery invalidates every queued fault, including a partially delivered
    // open/reminder/escalation. Do not send the remaining recipients stale faults.
    // Recovery history is retained for the daily report only.
    if (!m.severity) {
      if(previousSeverity&&userFacing(p)) {
        state.recovered??=[];state.recovered.push({at:now,key:p.key,startedAt:m.incident,evidence:m.evidence??state.outbox.find(n=>n.key===p.key)?.evidence});
      }
      delete m.trigger;
      state.outbox=state.outbox.filter(n=>n.key!==p.key || n.kind==="recovery");
      if (p.product === "Service") {
        m.notifiedSeverity = 0;
        m.lastNotified = now;
        state.outbox = state.outbox.filter(n => n.key !== p.key);
      }
    }
    if(userFacing(p)&&m.severity)m.evidence=describeEvidence(p,m,frame.at,rules);
    // Keep diagnosis and baseline state, but reserve all mail capacity for
    // observed business/runtime failures and account-level spend signals.
    if (!userFacing(p)) continue;
    const waiting=state.outbox.find(n=>n.key===p.key);
    if(waiting && m.severity>waiting.severity){
      waiting.severity=m.severity;waiting.kind=m.notifiedSeverity || waiting.delivered.length ? "escalation" : "open";
      waiting.text=describeNotice(p,m,frame.at,ratio);waiting.delivered=[];
    }
    if (waiting && m.severity > 0) {
      waiting.text = describeNotice(p, m, frame.at, ratio);
      waiting.evidence = describeEvidence(p, m, frame.at, rules);
    }
    let kind: Notice["kind"] | undefined;
    if (!m.severity) {m.notifiedSeverity=0;continue;}
    else if (m.severity && !m.notifiedSeverity) kind = "open";
    else if (m.severity > m.notifiedSeverity) kind = "escalation";
    else if (m.severity && now - m.lastNotified >= reminderInterval(p.key,m.severity)) kind = "reminder";
    if(kind&&kind!=="escalation"&&classify({key:p.key,severity:m.severity}).priority===2&&m.lastP2Notified&&now-m.lastP2Notified<HISTORY_TTL_MS)kind=undefined;
    if (kind && !state.outbox.some(n => n.key === p.key)) {
      if (state.outbox.length >= MAX_NOTICES) throw new Error("Notification outbox limit exceeded");
      state.outbox.push({ startedAt:m.incident, id: `${p.key}:${m.incident}:${kind}:${Math.floor(now/reminderInterval(p.key,m.severity))}`, key: p.key, kind, severity: m.severity,
        text: describeNotice(p, m, frame.at, ratio),
        evidence: describeEvidence(p, m, frame.at, rules),
        delivered: [], attempts: 0, expiresAt: now + STATE_TTL_MS });
    }
  }
  for(const notice of state.outbox)if(state.metrics[notice.key])delete state.metrics[notice.key].evidence;
  state.lastFrame = frame.at;
  if (frame.costComplete !== false && ["D1", "Workers", "R2", "KV", "DO", "Queues"].every(p => frame.healthy.includes(p as Product)) && !frame.errors.length) state.lastSuccess = now;
  state.lastError = frame.errors.length ? frame.errors.join("; ").slice(0,500) : null;
}
export function acknowledge(state: State, notice: Notice, now: number): void {
  const m = state.metrics[notice.key];
  if (m) { m.notifiedSeverity = notice.severity; m.lastNotified = now; m.evidence=notice.evidence;if(classify(notice).priority===2)m.lastP2Notified=now; }
  state.outbox = state.outbox.filter(n => n.id !== notice.id);
  state.recentDelivery.push({ at: now, id: notice.id, kind: notice.kind, recipients: notice.delivered.length });
  compact(state, now);
}

const RESOURCE_NAMES: Record<string,string> = {
  "e4695b85cce24b3d843c4744865ed203": "共享协调缓存（ghfind-coord / KeyValue）",
  "60d45096-bfe7-4de1-8b85-c1b66a466b0d": "主数据库 ghfind",
  "9c4ac13a-4c90-40a8-9d56-d7141f864bbf": "Feed 数据库",
  "f7a7299eef224d899c21121c1979be32": "应用缓存 ghfind-cache",
  account: "Cloudflare 账户",
};
function money(n:number):string { return n>0 && n<0.000001 ? "<$0.000001" : `$${n.toFixed(6)}`; }
function percentage(value: number): string { return `${(value * 100).toLocaleString("en-US", { maximumFractionDigits: 1 })}%`; }
function failureSignal(p: Point): boolean { return p.product === "Service" || p.product === "Workers" && p.key.endsWith(":errors"); }
function observation(p: Point): string {
  const count = p.amount.toLocaleString("en-US");
  if (p.key === "account:burn" && p.costLowerBound) return `本 5 分钟已观测至少 $${p.usd.toFixed(2)}`;
  if (p.key.startsWith("Service:probe-")) return p.amount ? `公开检查失败 ${count} 次` : "本次公开检查通过";
  if (failureSignal(p)) {
    const result = p.key.endsWith(":slow") ? `响应超过 30 秒` : "失败";
    return p.operations > 0
      ? `${p.scope ? `${p.scope} ` : ""}${p.operations.toLocaleString("en-US")} 次${p.product === "Service" ? "调用" : "运行"}中 ${count} 次${result}（${percentage(p.amount / p.operations)}）`
      : p.amount ? `已观测 ${count} 次${result}；本窗缺少调用总数` : `本窗口没有${p.product === "Service" ? "调用" : "运行"}样本`;
  }
  return `${count} ${p.unit}${p.efficiency === undefined ? "" : `；每次${p.denominator ?? "操作"} ${p.efficiency.toFixed(2)} ${p.unit}`}`;
}
function availabilityImpact(p: Point): string | undefined {
  if (!failureSignal(p)) return;
  if (p.key.startsWith("Service:probe-")) return p.amount ? "自动检查未收到预期响应；请复查公开页面是否可访问。" : "本次自动检查收到预期响应。";
  if (!p.amount) return "本窗口未再观测到该问题。";
  if (p.key.endsWith(":slow")) return "部分请求等待超过 30 秒，用户可能需要等待更久才能看到结果。";
  return p.product === "Service" ? "部分功能调用失败，相关用户可能未能获得结果。" : "已观测到 Worker 运行失败；需结合请求日志确认受影响功能。";
}
export function describeEvidence(p: Point, m: MetricState, at: number, rules = DEFAULT_RULES): NoticeEvidence {
  const resource = RESOURCE_NAMES[p.resource] ?? p.resource;
  const time = (n: number) => new Date(n + 8 * 3600_000).toISOString().slice(5, 16).replace("T", " ");
  const e: NoticeEvidence = {
    startedAt:m.incident, resource, metric: p.label, value: observation(p),
    window: p.observedAt ? `${time(p.observedAt)} 北京时间` : `${time(at)}–${time(at + WINDOW_MS)} 北京时间`,
    action: p.product === "Service" ? "检查该功能部署、上游服务及失败请求日志。" : p.product === "D1" ? "检查查询计划、索引与重复查询。" : p.product === "Workers" ? "检查错误日志、CPU 耗时与最近部署。" : "检查流量变化、重试与重复操作。",
  };
  if (failureSignal(p)) {
    e.impact = availabilityImpact(p);
    if(p.key.endsWith(":slow")&&p.operations>0&&p.efficiencyWarning!==undefined){
      const excess=(p.amount/p.operations-p.efficiencyWarning)*100;
      e.impact=`${percentage(p.amount/p.operations)} 请求超过 30 秒；${excess>=0?`高出阈值 ${excess.toFixed(1)} 个百分点`:"当前低于阈值，等待恢复确认"}。 ${e.impact??""}`;
    }
  }
  else if (p.product === "Billing") {
    e.window = `${p.resource} 已上报日账单`;
    e.cost = `已上报 $${p.amount.toFixed(2)}；账单可能调整。`;
  } else if (p.key === "account:burn") {
    const windows = m.burnWindows ?? [];
    const rate = (n: number) => windows.length >= n && windows.slice(-n).every(([t], i) => t === at - (n - 1 - i) * WINDOW_MS)
      ? `$${(windows.slice(-n).reduce((sum, [, usd]) => sum + usd, 0) * 12 / n).toFixed(2)}/h` : "数据未齐";
    e.value = p.costLowerBound ? observation(p) : `5 分钟 $${p.amount.toFixed(2)}/h；15 分钟 ${rate(3)}；1 小时 ${rate(12)}`;
    e.cost = p.costLowerBound ? "部分产品尚未覆盖；该数额按已观测用量的套餐外单价估算，未扣套餐额度，非最终账单。" : `本 5 分钟 ${money(p.usd)}，按套餐外单价估算；未扣套餐额度。`;
    e.action = "核对各产品用量及 Cloudflare 已上报账单，排查流量或操作突增。";
  } else e.cost = `本 5 分钟 ${money(p.usd)}，按套餐外单价估算；未扣套餐额度。`;
  const current = triggerFor(p, m, at, rules);
  if(current&&p.key.startsWith("Service:probe-")&&m.bad>=2){current.severity=2;current.condition="连续两次公开检查失败";}
  if (current?.basis === "relative") e.value += `；${current.observed}`;
  if (!m.severity) e.threshold = "已连续两个有效窗口恢复正常";
  else if (current && current.severity >= m.severity) e.threshold = current.condition;
  else {
    e.threshold = m.trigger
      ? `历史${m.trigger.severity >= 2 ? "严重" : "普通"}触发（${time(m.trigger.at)} UTC+8）：${m.trigger.condition}；当时${m.trigger.observed.replace("当前", "观测")}`
      : "历史告警仍待恢复确认；旧状态未保存原始触发依据";
    const status = current ? `当前仅满足普通条件：${current.condition}。` : "当前未再次确认原告警级别，仍待连续两个有效低窗口确认恢复。";
    e.impact = [e.impact, status].filter(Boolean).join(" ");
  }
  return e;
}
export function describeNotice(p:Point,m:MetricState,at:number,ratio:number):string {
  const category = p.product==="Service" ? "关键功能故障" : p.key.endsWith(":errors") ? "运行错误" : p.product==="Billing" || p.key==="account:burn" ? "账单风险" : "性能 / 用量异常";
  const time = (n:number)=>new Date(n+8*3600_000).toISOString().slice(0,16).replace("T"," ");
  const advice = p.product==="Service" ? "优先检查该功能的部署、上游服务和生成结果日志；故障可能直接影响用户。" : p.product==="D1" ? "检查查询计划、索引、缓存命中与重复查询。" : p.product==="DO" || p.product==="KV" ? "检查缓存命中、协调对象轮询、重试与批量读写。" : p.product==="Workers" ? "检查异常日志、CPU 耗时、循环与近期部署。" : "检查流量变化、重复操作及近期部署。";
  const baseline = p.relative===false || m.samples < 12 || ratio < 3 ? "" : `；健康基线 ${ratio.toFixed(1)} 倍`;
  const cost = p.product==="Billing" ? `已上报日费用：$${p.amount.toFixed(4)}；对应日期：${p.resource}。账单可能延迟或调整，每 6 小时重新对账。` : p.costLowerBound ? "部分产品尚未覆盖；该数额按已观测用量的套餐外单价估算，未扣套餐额度，非最终账单。" : availabilityImpact(p) ?? `本 5 分钟 ${money(p.usd)}，按套餐外单价估算；未扣套餐额度，非最终账单。`;
  const period=p.observedAt ? `探测时间（北京时间）：${time(p.observedAt)}` : `北京时间：${time(at)} 至 ${time(at+WINDOW_MS)}`;
  return `【${category}】${RESOURCE_NAMES[p.resource]??p.resource} / ${p.label}\n${m.severity?"需要排查":"已连续两个有效窗口恢复正常"}：${observation(p)}${baseline}\n${period}\n${cost}\n建议：${advice}`;
}

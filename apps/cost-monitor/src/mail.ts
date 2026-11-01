import { classify } from "./classify";
import type { Notice, State } from "./engine";
import { userFacing } from "./mail-policy";

export interface MailOptions {
  accountId: string;
  now: number;
  exercise?: boolean;
  digest?: boolean;
}
export interface RenderedMail { subject: string; text: string; html: string }
interface Item {
  notice: Notice;
  resource: string;
  metric: string;
  value: string;
  threshold: string;
  window: string;
  action: string;
  impact: string;
  cost: string;
}
interface Group { key: string; resource: string; items: Item[]; rank: number; recovered: boolean }
const TOP_GROUPS = 3;
const TOP_METRICS = 3;
const OTHER_GROUPS = 5;
const RUNBOOK = "https://developers.cloudflare.com/workers/observability/";


function escape(value: string): string {
  return value.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
function line(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim();
}
function short(value: string, length: number): string {
  const chars = Array.from(line(value));
  return chars.length > length ? chars.slice(0, length - 1).join("") + "…" : chars.join("");
}
function field(lines: string[], name: string): string {
  return lines.find(s => s.startsWith(name + "："))?.slice(name.length + 1).trim() ?? "";
}
function billing(notice: Notice): boolean { return notice.key === "account:burn" || notice.key.startsWith("Billing:"); }
// These old engine strings describe alert policy, not a consequence for the reader.
// Keep any following historical severity/recovery explanation intact.
function impact(value: string): string {
  return value.replace("影响可用性；不按费用降级。", "").replace("影响可用性，不按费用降级。", "").trim();
}
function parse(notice: Notice): Item {
  if (notice.evidence) return { notice, ...notice.evidence, threshold: notice.evidence.threshold ?? "", impact: impact(notice.evidence.impact ?? ""), cost: notice.evidence.cost ?? "" };
  const lines = notice.text.split("\n").map(line).filter(Boolean);
  const first = (lines[0] ?? notice.key).replace(/^【[^】]*】\s*/, "");
  const slash = first.indexOf(" / ");
  const resource = field(lines, "影响对象").replace(/（[^（）]*）$/, "") || (slash >= 0 ? first.slice(0, slash) : first);
  const metric = slash >= 0 ? first.slice(slash + 3) : first;
  const window = lines.find(s => /^(北京时间|探测时间（北京时间）|观测时间|时间窗口|统计窗口|窗口|时间)：/.test(s)) ?? "";
  const cost = lines.find(s => /^(本窗口套餐外单价估算|本 5 分钟|已上报日费用|估算费用|费用说明|已覆盖用量)/.test(s)) ?? "";
  return {
    notice, resource, metric,
    value: field(lines, "观测值") || field(lines, "当前值") || field(lines, "需要排查") || field(lines, "已连续两个有效窗口恢复正常") || "",
    threshold: field(lines, "触发条件") || field(lines, "触发阈值") || field(lines, "阈值") || field(lines, "触发依据"),
    window, cost, impact: "",
    action: field(lines, "建议") || (notice.key.startsWith("Service:") ? "检查该功能的近期部署和失败请求日志。" : "检查近期流量、部署和重试变化。"),
  };
}
function groupsFor(notices: Notice[]): Group[] {
  const groups = new Map<string, Group>();
  for (const notice of notices) {
    const item = parse(notice);
    // Group correlated database counters without summing diagnostic costs twice.
    // Recovered metrics never make an active resource look healthy.
    const key = `${notice.key.split(":").slice(0, 2).join(":")}:${notice.kind === "recovery" ? "resolved" : "active"}`;
    const rank = 4-classify(notice).priority;
    const group = groups.get(key) ?? { key, resource: item.resource, items: [], rank, recovered: notice.kind === "recovery" };
    group.items.push(item);
    group.rank = Math.max(group.rank, rank);
    groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => b.rank - a.rank || a.key.localeCompare(b.key)).map(group => ({
    ...group, items: group.items.sort((a, b) => b.notice.severity - a.notice.severity || a.notice.key.localeCompare(b.notice.key)),
  }));
}
function problem(group: Group): string {
  const lead = group.items[0];
  const resource = short(group.resource, 42);
  if (group.recovered) return `${resource}的${short(lead.metric, 24)}告警已解除`;
  // A latched critical incident can currently be below its original threshold.
  // Avoid asserting it is still increasing when recovery is merely unconfirmed.
  if (/历史.*触发|历史告警仍待恢复/.test(lead.threshold)) return `${resource}的异常仍待恢复确认`;
  if (lead.notice.key === "account:burn") return "Cloudflare 估算消耗达到告警阈值";
  if (lead.notice.key.startsWith("Billing:")) return "Cloudflare 日费用达到告警阈值";
  if (lead.notice.key.startsWith("Service:probe-")) return `${resource}的可用性检查未通过`;
  if (lead.notice.key.startsWith("Service:") && lead.notice.key.endsWith(":errors")) return `${resource}出现失败`;
  if (lead.notice.key.startsWith("Service:") && lead.notice.key.endsWith(":slow")) return `${resource}响应变慢`;
  if (lead.notice.key.endsWith(":errors")) return `${resource}出现运行错误`;
  return `${resource}的${short(lead.metric, 24)}偏高`;
}
function headline(group:Group):string {
  const lead=group.items[0];
  return `${problem(group)}：${short(lead.value||"待复核",100)}（阈值 ${short(lead.threshold||"待复核",100)}）`;
}
export function renderSummary(notice:Notice,now:number):string {
  const item=parse(notice),started=notice.startedAt??notice.evidence?.startedAt;
  return `问题：${item.resource} / ${item.metric}（${notice.severity>=2?"严重":"预警"}）\n开始时间：${started?`${time(started)}，已持续 ${Math.max(0,Math.floor((now-started)/60_000))} 分钟`:"历史记录未提供"}\n影响：${item.impact||(billing(notice)?"账户费用风险，请核对消耗与账单。":"见当前观测，需复核受影响请求。")}`;
}
function time(at: number): string {
  return new Date(at + 8 * 3600_000).toISOString().slice(0, 16).replace("T", " ") + " UTC+8";
}
function plainGroup(group: Group): string {
  return [headline(group), ...group.items.map(item => {

    return [group.items.length > 1 ? item.metric : "", item.value ? `观测：${item.value}` : "", item.impact,
      group.recovered ? "无需处理；该指标已满足恢复条件。" : `建议：${item.action}`,
      item.window ? `观测时段：${item.window}` : "",
      item.notice.startedAt ? `开始时间：${time(item.notice.startedAt)}` : "", item.threshold ? `阈值：${item.threshold}` : ""].filter(Boolean).join("\n");
  })].join("\n\n");
}
function groupHtml(group: Group, first: boolean, dashboard:string): string {
  const lead = group.items[0];
  const items = group.items.slice(0, TOP_METRICS);
  const heading = first ? "h1" : "h2";
  const values = items.map(item => `<p style="margin:0 0 8px;font-size:15px;line-height:1.65">${group.items.length > 1 ? `${escape(short(item.metric, 60))}：` : ""}${escape(short(item.value, 180) || "详见下方观测记录")}</p>`).join("");
  const evidence = items.map(item => {
    const facts = [group.items.length > 1 ? item.metric : "", item.notice.startedAt?`开始时间：${time(item.notice.startedAt)}`:"", item.window, item.threshold ? `触发依据：${item.threshold}` : ""].filter(Boolean);
    return `<p class="muted" style="margin:8px 0 0;color:#58636e;font-size:12px;line-height:1.65">${facts.map(f => escape(short(f, 260))).join("<br>")}</p>`;
  }).join("");
  const action = group.recovered ? "无需处理；该指标已满足恢复条件。" : lead.action;
  return `<tr><td${first ? "" : ' class="divider"'} style="padding:${first ? "0 0 22px" : "22px 0"}${first ? "" : ";border-top:1px solid #dde2e7"}"><${heading} style="margin:0 0 12px;font-size:18px;line-height:1.5;font-weight:650">${escape(headline(group))}</${heading}>${values}${lead.impact ? `<p style="margin:0 0 10px;font-size:14px;line-height:1.65">${escape(short(lead.impact, 220))}</p>` : ""}<p style="margin:12px 0;font-size:14px;line-height:1.65">${group.recovered ? "" : '<strong style="font-weight:600">建议：</strong>'}${escape(short(action, 220))}</p>${evidence}<p><a class="link" href="${escape(dashboard)}" style="color:#176252">查看观测</a></p>${group.items.length > TOP_METRICS ? `<p class="muted" style="margin:8px 0 0;color:#58636e;font-size:12px;line-height:1.65">同一资源的其余 ${group.items.length - TOP_METRICS} 项观测见纯文本版本。</p>` : ""}</td></tr>`;
}

/** No recipients, secrets or network requests. Internal collector failures are
 * excluded even if an old caller passes them together with a customer incident. */
export function renderMail(input: Notice[], options: MailOptions): RenderedMail {
  const notices = input.filter(n=>userFacing(n)&&n.kind!=="recovery");
  if (!notices.length) return { subject: "", text: "", html: "" };
  const groups = groupsFor(notices);
  const lead = groups[0];
  const title = headline(lead);
  const classification=classify(lead.items[0].notice);
  const subject = `[ghfind]${options.exercise ? "[模拟]" : ""}[P${classification.priority}][${classification.category}] ${title}${notices.length > 1 ? `，另有 ${notices.length - 1} 项进行中` : ""}`;
  const summary=renderSummary(lead.items[0].notice,options.now);
  const details=notices.map(n=>n.evidence?.cost).filter(Boolean).join("\n");
  // Only fixed paths and a validated account ID can become clickable links.
  const account = /^[a-f\d]{32}$/i.test(options.accountId) ? `https://dash.cloudflare.com/${options.accountId}` : "https://dash.cloudflare.com";
  const leadBilling = lead.items.some(item => billing(item.notice));
  const dashboard = leadBilling ? `${account}/billing/billable-usage` : account;
  const linkLabel = leadBilling ? "核对用量与账单" : "查看 Cloudflare 监控";
  const exercise = options.exercise ? "模拟数据 · 告警演练，不代表生产事故。" : "";
  const text = [summary, subject, time(options.now), exercise, ...groups.map(plainGroup), details?`技术细节：\n${details}`:"", `${linkLabel}：${dashboard}`, `监控口径与排查说明：${RUNBOOK}`].filter(Boolean).join("\n\n");
  const rest = groups.slice(TOP_GROUPS);
  const restHtml = rest.length ? `<tr><td class="divider" style="padding:20px 0;border-top:1px solid #dde2e7"><h2 style="margin:0 0 8px;font-size:15px;line-height:1.5;font-weight:600">其余进行中问题</h2>${rest.slice(0, OTHER_GROUPS).map(group => `<p style="margin:8px 0;font-size:14px;line-height:1.65">${escape(headline(group))}</p>`).join("")}<p class="muted" style="margin:10px 0 0;color:#58636e;font-size:12px;line-height:1.65">${rest.length > OTHER_GROUPS ? `另有 ${rest.length - OTHER_GROUPS} 项变化。` : ""}完整观测记录见邮件纯文本版本。</p></td></tr>` : "";
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark"><title>${escape(subject)}</title><style>:root{color-scheme:light dark}body{margin:0}table{border-collapse:collapse}a:focus-visible{outline:2px solid #176252;outline-offset:3px}@media(prefers-color-scheme:dark){.outer{background:#171a1e!important}.sheet{background:#20252a!important;color:#edf1f5!important}.muted{color:#b7c0c9!important}.divider{border-color:#414950!important}.link{color:#a7ddcb!important}a:focus-visible{outline-color:#a7ddcb!important}}@media(max-width:480px){.shell{padding:12px 0!important}.content{padding:22px 16px!important}}</style></head><body class="outer" style="margin:0;background:#f0f2f4;color:#242c34;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif"><div aria-hidden="true" style="display:none;max-height:0;overflow:hidden;mso-hide:all">${escape(short(lead.items[0].value, 110))}</div><table role="presentation" width="100%" class="outer" style="background:#f0f2f4"><tr><td class="shell" align="center" style="padding:24px 16px"><table role="presentation" width="100%" class="sheet" style="max-width:640px;background:#ffffff;color:#242c34;table-layout:fixed"><tr><td class="content" style="padding:28px;overflow-wrap:anywhere;word-break:break-word"><p class="muted" style="margin:0 0 24px;font-size:12px;line-height:1.6;color:#58636e">ghfind · 运行与费用通知<br>${escape(time(options.now))}</p>${exercise ? `<p class="muted" style="margin:0 0 16px;font-size:12px;line-height:1.6;color:#58636e">${exercise}</p>` : ""}<table role="presentation" width="100%" style="table-layout:fixed">${`<tr><td style="padding-bottom:20px;white-space:pre-line">${escape(summary)}</td></tr>`}${groups.slice(0, TOP_GROUPS).map((group, i) => groupHtml(group, i === 0,dashboard)).join("")}${restHtml}</table><details><summary>技术细节</summary><p>${escape(details)}</p></details><p class="divider" style="margin:0;padding-top:8px;border-top:1px solid #dde2e7;font-size:13px;line-height:1.6"><a class="link" href="${escape(dashboard)}" style="display:inline-block;min-height:44px;box-sizing:border-box;padding:12px 0;color:#176252;text-decoration:underline">${linkLabel}</a><br><a class="link muted" href="${RUNBOOK}" style="display:inline-block;min-height:44px;box-sizing:border-box;padding:12px 0;color:#58636e;text-decoration:underline;font-size:12px">监控口径与排查说明</a></p></td></tr></table></td></tr></table></body></html>`;
  return { subject, text, html };
}

export function renderDailyDigest(state:State,now:number,options:Partial<MailOptions>={}):RenderedMail {
  const active=Object.entries(state.metrics).filter(([key,m])=>m.severity>0&&userFacing({key})).map(([key,m]):Notice=>({id:key,key,kind:"reminder",severity:m.severity,startedAt:m.incident,text:key,evidence:m.evidence??state.outbox.find(n=>n.key===key)?.evidence,delivered:[],attempts:0,expiresAt:now+1}));
  for(const notice of state.outbox)if(userFacing(notice)&&notice.kind!=="recovery"&&!active.some(n=>n.key===notice.key))active.push(notice);
  const p0=active.filter(n=>classify(n).priority===0).length;
  const date=new Date(now+8*3600_000).toISOString().slice(5,10);
  const subject=`[ghfind]${options.exercise?"[模拟]":""}[日报] ${active.length?`${active.length} 项进行中${p0?`（P0×${p0}）`:""}`:"全部正常"} · ${date}`;
  const windows=(state.consumption??[]).filter(([at])=>at>now-86400_000);
  const footer=[`24h 估算消耗：$${windows.reduce((sum,[,usd])=>sum+usd,0).toFixed(4)}（覆盖 ${windows.length}/288 个窗口；未扣套餐额度，非最终账单）`,state.latestBill?`最新日账单：${state.latestBill.date} $${state.latestBill.value.toFixed(2)}`:"最新日账单：暂无数据",`监控心跳：${state.lastCompletedAt||state.lastAttempt?time(state.lastCompletedAt||state.lastAttempt):"尚无完成记录"}`,"过去 24h 已恢复：",...(state.recovered??[]).filter(n=>n.at>now-86400_000).map(n=>`${n.evidence?.resource??n.key} · ${time(n.at)}`)];
  const body=active.length?renderMail(active,{accountId:options.accountId??"",now,exercise:options.exercise}):null;
  const text=[subject,body?.text??"当前无进行中问题。",...footer].join("\n\n");
  const appendix=`<section style="padding:24px;white-space:pre-line">${escape(footer.join("\n"))}</section>`;
  const html=body?body.html.replace('</body>',`${appendix}</body>`):`<!doctype html><html lang="zh-CN"><head><meta name="color-scheme" content="light dark"></head><body style="font:15px/1.7 system-ui;padding:24px"><h1>${escape(subject)}</h1>${appendix}</body></html>`;
  return {subject,text,html};
}

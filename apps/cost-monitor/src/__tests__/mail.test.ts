import { describe, expect, it } from "vitest";
import { emptyState, type Notice } from "../engine";
import { renderDailyDigest, renderMail } from "../mail";

const now = Date.UTC(2026, 9, 13, 3, 10);
const options = { accountId: "8f19bebe359e4ec1a24c68c5f49c1584", now, digest: true };
function notice(key: string, overrides: Partial<Notice> = {}): Notice {
  const resource = key.split(":")[1];
  return { id: key, key, kind: "open", severity: 1, delivered: [], attempts: 0, expiresAt: now + 86400000,
    text: `【运行错误】${resource} / 请求错误\n影响对象：${resource}（Workers）\n观测值：100 次请求中出现 3 次错误\n北京时间：2026-10-13 11:00 至 2026-10-13 11:05\n建议：检查近期部署。`, ...overrides };
}

describe("customer alert email", () => {
  it("returns no message for empty inputs or internal monitoring diagnostics", () => {
    for (const rows of [[], [notice("Monitor:collection:health", { severity: 2 })], [notice("D1:db:sql:abc"), notice("Workers:worker:cpu")]]) {
      expect(renderMail(rows, options)).toEqual({ subject: "", text: "", html: "" });
    }
  });

  it("excludes internal collector and efficiency content from mixed inputs", () => {
    const rows = [notice("Monitor:collection:health", { text: "private-collector-token-diagnosis", severity: 2 }), notice("D1:db:read", { text: "sql-diagnostic-only" }), notice("Service:homepage:errors", { severity: 2 })];
    const before = structuredClone(rows);
    const mail = renderMail(rows, options);
    expect(mail.subject).toContain("[ghfind][P1][Worker] homepage出现失败");
    for (const output of [mail.subject, mail.html, mail.text]) {
      expect(output).not.toContain("private-collector-token-diagnosis");
      expect(output).not.toContain("sql-diagnostic-only");
      expect(output).not.toContain("数据缺口");
    }
    expect(rows).toEqual(before);
  });

  it("puts actual impact and observations before the action and technical condition", () => {
    const row = notice("Service:analysis:errors", { severity: 2, evidence: {
      resource: "首页 GitHub 分析", metric: "关键功能失败", value: "12 次调用中失败 3 次（25%）",
      threshold: "至少观测到 1 次失败", window: "10-13 11:00–11:05 北京时间",
      impact: "部分请求失败，可能影响该功能使用。", action: "检查该功能的近期部署和失败请求日志。",
    } });
    const mail = renderMail([row], options);
    expect(mail.subject).toContain("[ghfind][P1][Worker] 首页 GitHub 分析出现失败");
    expect(mail.html.indexOf(row.evidence!.value)).toBeLessThan(mail.html.indexOf(row.evidence!.action));
    expect(mail.subject).toContain(row.evidence!.threshold!);
    expect(mail.html.match(/<h[12][^>]*>/g)).toHaveLength(1);
    expect(mail.html).not.toMatch(/个对象|项指标|font-size:29px|class="cta"/);
    expect(mail.text).not.toContain("仍持续 5 分钟"); // A window is not incident age.
  });

  it("does not conflate a failed availability probe with failed user requests", () => {
    const row = notice("Service:probe-frontend:errors", { evidence: { resource: "ghfind 主页", metric: "公开可用性检查", value: "1 次检查失败", window: "11:05 北京时间", action: "检查公开页面是否可访问。" } });
    expect(renderMail([row], options).subject).toContain("[ghfind][P2][可用性] ghfind 主页的可用性检查未通过");
  });

  it("shows cost values and estimate qualifications without forecasting an invoice", () => {
    const row = notice("account:burn", { severity: 2, evidence: {
      resource: "Cloudflare 账户", metric: "用量消耗速度", value: "5 分钟 $2.40/h；15 分钟 $2.20/h；1 小时 $1.80/h",
      threshold: "5 + 15 分钟均 ≥ $2/h", window: "10-13 11:00–11:05 北京时间",
      action: "核对各产品用量及 Cloudflare 已上报账单，排查流量或操作突增。", cost: "本 5 分钟 $0.200000，按套餐外单价估算；未扣套餐额度。",
    } });
    const mail = renderMail([row], options);
    expect(mail.subject).toContain("[ghfind][P0][计费] Cloudflare 估算消耗达到告警阈值");
    for (const name of ["value", "threshold", "window", "action", "cost"] as const) {
      expect(mail.text).toContain(row.evidence![name]);
      expect(mail.html).toContain(row.evidence![name]);
    }
    expect(mail.html).toContain('/billing/billable-usage"');
    expect(mail.html).toContain("核对用量与账单");
    expect(mail.html).not.toContain("预计每日");
  });

  it("distinguishes reported billing from an estimated burn rate", () => {
    const row = notice("Billing:account:daily", { evidence: { resource: "2026-10-12", metric: "日账单", value: "$12.50", window: "2026-10-12 已上报日账单", action: "核对用量与账单。", cost: "账单可能调整。" } });
    const mail = renderMail([row], options);
    expect(mail.subject).toContain("[ghfind][P0][计费] Cloudflare 日费用达到告警阈值");
    expect(mail.html).toContain("2026-10-12 已上报日账单");
    expect(mail.html).toContain("账单可能调整");
  });

  it("preserves historical severity explanations without claiming ongoing escalation", () => {
    const row = notice("account:burn", { evidence: { resource: "Cloudflare 账户", metric: "用量消耗速度", value: "5 分钟 $0.60/h", window: "11:00–11:05", threshold: "历史严重触发（10:30 UTC+8）：5 + 15 分钟均 ≥ $2/h", action: "核对用量。", impact: "当前未再次确认原告警级别，仍待连续两个有效低窗口确认恢复。" } });
    const mail = renderMail([row], options);
    expect(mail.subject).toContain("仍待恢复确认");
    expect(mail.subject).not.toContain("达到告警阈值");
    expect(mail.html).toContain(row.evidence!.impact);
  });

  it("groups related service failures and slowness while keeping recovery separate", () => {
    const mail = renderMail([notice("Service:homepage:errors", { severity: 2 }), notice("Service:homepage:slow"), notice("Service:homepage:other", { kind: "recovery", severity: 0 })], options);
    expect(mail.html.match(/<h[12][^>]*>/g)).toHaveLength(1);
    expect(mail.subject).toContain("homepage出现失败");
    expect(mail.html).not.toContain("告警已解除");
    expect(mail.html).not.toContain("所有服务正常");
  });

  it("keeps structured evidence once in plaintext and supports old notice text", () => {
    const row = notice("Workers:worker:errors", { text: "old duplicate description", evidence: { resource: "worker", metric: "运行错误", value: "3 次错误", window: "10:35–11:10 UTC+8", action: "Inspect-error-logs", impact: "影响可用性；不按费用降级。历史告警尚待恢复。" } });
    const mail = renderMail([row], options);
    expect(mail.text).not.toContain("old duplicate description");
    expect(mail.text.match(/Inspect-error-logs/g)).toHaveLength(1);
    expect(mail.text.match(/10:35–11:10 UTC\+8/g)).toHaveLength(1);
    expect(mail.html).not.toContain("不按费用降级");
    expect(mail.html).toContain("历史告警尚待恢复");
    const legacy = notice("Workers:worker:errors", { text: "【运行错误】worker / 运行错误\n需要排查：3 次错误\n北京时间：11:00 至 11:05\n建议：检查日志。" });
    expect(renderMail([legacy], options).html).toContain("3 次错误");
    expect(renderMail([legacy], options).text).not.toContain(legacy.text);
  });

  it("bounds HTML for 64 incidents and retains their full evidence in plaintext", () => {
    const rows = Array.from({ length: 64 }, (_, i) => notice(`Workers:resource-${i}:errors`, { text: `【运行错误】resource-${i} / 请求错误\n观测值：1,000 次\n建议：action-${i}` }));
    const mail = renderMail(rows, options);
    expect(mail.html).toContain("其余进行中问题");
    expect(mail.html).toContain("另有 56 项变化");
    expect(new TextEncoder().encode(mail.html).byteLength).toBeLessThan(14000);
    for (let i = 0; i < 64; i++) expect(mail.text).toContain(`action-${i}`);
  });

  it("escapes hostile text and only makes trusted paths clickable", () => {
    const mail = renderMail([notice("Workers:worker:errors", { evidence: { resource: '<svg onload="alert(1)">', metric: "运行错误", value: '<script>alert(2)</script>', window: "now", action: "javascript:alert(3)" } })], { ...options, accountId: 'evil.example/" onclick="alert(1)' });
    expect(mail.html).not.toContain("<script>");
    expect(mail.html).not.toContain("<svg");
    expect(mail.html).not.toContain('onclick="');
    expect(mail.html).toContain("&lt;script&gt;");
    const links = [...mail.html.matchAll(/href="([^"]*)"/g)].map(match => match[1]);
    expect([...new Set(links)]).toEqual(["https://dash.cloudflare.com", "https://developers.cloudflare.com/workers/observability/"]);
  });

  it("keeps header fields on one line and marks simulated incidents", () => {
    const row = notice("Service:homepage:errors", { evidence: { resource: "homepage\r\nBcc: attacker@example.com", metric: "失败", value: "1", window: "now", action: "check" } });
    expect(renderMail([row], options).subject).not.toMatch(/[\r\n\u0000]/);
    const exercise = renderMail([row], { ...options, exercise: true });
    expect(exercise.subject).toContain("[ghfind][模拟]");
    expect(exercise.html).toContain("模拟数据");
    expect(exercise.text).toContain("不代表生产事故");
  });

  it("supports inline fallback, dark mode, mobile, and visible keyboard focus without remote assets", () => {
    const mail = renderMail([notice("Workers:worker:errors")], options);
    expect(mail.html).toContain("prefers-color-scheme:dark");
    expect(mail.html).toContain("@media(max-width:480px)");
    expect(mail.html).toContain("min-height:44px");
    expect(mail.html).toContain("a:focus-visible");
    expect(mail.html).toContain('lang="zh-CN"');
    expect(mail.html).not.toMatch(/<img|<script|<iframe|<link\s/i);
    expect(mail.text).toContain("2026-10-13 11:10 UTC+8");
  });
});

it("prioritizes billing warnings above critical service failures and excludes recoveries from counts",()=>{
 const rows=[notice("Service:roast:errors",{severity:2}),notice("account:burn"),notice("Workers:old:errors",{kind:"recovery"})];
 const mail=renderMail(rows,options);
 expect(mail.subject).toMatch(/^\[ghfind\]\[P0\]\[计费\]/);
 expect(mail.subject).toContain("另有 1 项进行中");
 expect(mail.text).not.toContain("old");
});
it("opens with a three-line summary and actual incident age",()=>{
 const mail=renderMail([notice("Service:roast:slow",{startedAt:now-90*60_000})],options);
 expect(mail.text.split("\n").slice(0,3)).toEqual([expect.stringMatching(/^问题：/),expect.stringMatching(/开始时间：.*UTC\+8，已持续 90 分钟/),expect.stringMatching(/^影响：/)]);
});
it("renders an all-clear daily report with consumption, billing and heartbeat even with an empty queue",()=>{
 const state=emptyState();state.lastAttempt=now;state.consumption=[[now-300000,0.2]];state.latestBill={at:now,value:12,date:"2026-10-12"};
 const mail=renderDailyDigest(state,now);
 expect(mail.subject).toBe("[ghfind][日报] 全部正常 · 10-13");
 expect(mail.text).toContain("$0.2000");expect(mail.text).toContain("$12.00");expect(mail.text).toContain("监控心跳");
});

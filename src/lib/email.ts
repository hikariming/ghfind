import nodemailer from "nodemailer";
import { TIER_EN } from "./badge";
import {
  claimEmailNotification,
  getEmailNotificationCandidate,
  getHeatLeaderboard,
  markEmailNotificationSent,
  releaseEmailNotificationClaim,
  type EmailNotificationCandidate,
  type EmailNotificationKind,
} from "./db";
import type { RoastMeta } from "./types";

const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);
const DEFAULT_SITE_URL = "https://githubroast.icu";
const EMAIL_CTA = "快来 GitHub Roast 看看大家什么实力吧！";

interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  from: string;
  auth?: {
    user: string;
    pass: string;
  };
}

interface NotificationMessage {
  subject: string;
  text: string;
  html: string;
}

function envFlag(name: string): boolean {
  return TRUE_VALUES.has((process.env[name] ?? "").trim().toLowerCase());
}

export function emailAutomationEnabled(): boolean {
  return (
    envFlag("GHROAST_EMAIL_NOTIFICATIONS") &&
    envFlag("GHROAST_EMAIL_OWNER_APPROVED")
  );
}

function siteUrl(): string {
  return (process.env.PUBLIC_SITE_URL || DEFAULT_SITE_URL).replace(/\/+$/, "");
}

function smtpConfig(): SmtpConfig | null {
  const host = process.env.SMTP_HOST?.trim();
  const rawPort = Number(process.env.SMTP_PORT || 587);
  const user = process.env.SMTP_USER?.trim();
  const pass = process.env.SMTP_PASS;
  const fromAddress = (process.env.SMTP_FROM || user || "").trim();
  if (!host || !fromAddress || !Number.isFinite(rawPort)) return null;

  const fromName = (process.env.SMTP_FROM_NAME || "github roast").replace(/"/g, "").trim();
  const secure = process.env.SMTP_SECURE
    ? envFlag("SMTP_SECURE")
    : rawPort === 465;
  return {
    host,
    port: rawPort,
    secure,
    from: fromName ? `"${fromName}" <${fromAddress}>` : fromAddress,
    auth: user && pass ? { user, pass } : undefined,
  };
}

function stripControlLines(report: string): string {
  return report
    .split("\n")
    .filter((line) => !/^@@(?:ADJUST|TAGS)\b/.test(line.trim()))
    .join("\n")
    .trim();
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatTags(candidate: EmailNotificationCandidate): string {
  const tags = candidate.tags.zh.length > 0 ? candidate.tags.zh : candidate.tags.en;
  return tags.length > 0 ? tags.join(" / ") : "暂无";
}

function scoreLines(candidate: EmailNotificationCandidate): string[] {
  return [
    `GitHub 用户：@${candidate.username}`,
    candidate.display_name ? `显示名：${candidate.display_name}` : null,
    `最终分：${candidate.final_score.toFixed(2)}/100`,
    `等级：${candidate.tier} / ${TIER_EN[candidate.tier]}`,
    `热度：${candidate.lookup_count}`,
    `标签：${formatTags(candidate)}`,
  ].filter((line): line is string => Boolean(line));
}

function reportForEmail(
  candidate: EmailNotificationCandidate,
  reportOverride?: string,
): string {
  return stripControlLines(reportOverride ?? candidate.roast ?? candidate.roast_en ?? "");
}

function buildNotificationMessage(
  kind: EmailNotificationKind,
  candidate: EmailNotificationCandidate,
  reportOverride?: string,
): NotificationMessage {
  const profileUrl = `${siteUrl()}/u/${encodeURIComponent(candidate.username)}`;
  const cardUrl = `${siteUrl()}/api/card/${encodeURIComponent(candidate.username)}`;
  const homeUrl = siteUrl();
  const heading =
    kind === "god_score"
      ? `@${candidate.username} 的 GitHub 评分达到了“夯”`
      : `很多人正在烤 @${candidate.username} 的 GitHub 首页`;
  const subject =
    kind === "god_score"
      ? "你的GitHub评分为“夯”！"
      : "很多人正在烤你的 github 首页！";
  const report = reportForEmail(candidate, reportOverride);
  const scoreBlock = scoreLines(candidate).join("\n");
  const text = [
    heading,
    "",
    scoreBlock,
    "",
    `炫耀图：${cardUrl}`,
    `${EMAIL_CTA} ${homeUrl}`,
    "",
    "github roast",
  ].join("\n");
  const html = [
    '<div style="margin:0 auto;padding:24px;background:#0a0a0b;color:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;max-width:760px;border-radius:16px">',
    `<p style="margin:0 0 16px;font-size:16px;color:#e4e4e7">${escapeHtml(heading)}</p>`,
    `<a href="${escapeHtml(profileUrl)}" style="display:block;text-decoration:none">`,
    `<img src="${escapeHtml(cardUrl)}" alt="GitHub Roast card for @${escapeHtml(candidate.username)}" width="720" style="display:block;width:100%;max-width:720px;border-radius:14px;border:1px solid #27272a" />`,
    "</a>",
    `<p style="margin:18px 0 0;font-size:16px;font-weight:700;color:#e4e4e7">快来 <a href="${escapeHtml(homeUrl)}" style="color:#fb923c;text-decoration:underline;text-decoration-thickness:2px;text-underline-offset:4px">GitHub Roast ↗</a> 看看大家什么实力吧！</p>`,
    `<p style="margin:12px 0 0;font-size:13px;color:#a1a1aa">${escapeHtml(
      report ? "完整评分报告已在页面中展示。" : "打开页面查看最新评分结果。",
    )}</p>`,
    '<p style="margin:24px 0 0;font-size:13px;color:#a1a1aa">github roast</p>',
    "</div>",
  ].join("\n");
  return { subject, text, html };
}

async function sendEmailNotification(
  username: string,
  kind: EmailNotificationKind,
  reportOverride?: string,
): Promise<void> {
  if (!emailAutomationEnabled()) return;
  const config = smtpConfig();
  if (!config) {
    console.warn("email notification skipped: SMTP is not configured");
    return;
  }
  const candidate = await getEmailNotificationCandidate(username);
  if (!candidate) return;
  const message = buildNotificationMessage(kind, candidate, reportOverride);
  const claimed = await claimEmailNotification(
    candidate.username,
    kind,
    candidate.email,
    message.subject,
  );
  if (!claimed) return;

  try {
    const transporter = nodemailer.createTransport({
      host: config.host,
      port: config.port,
      secure: config.secure,
      auth: config.auth,
    });
    await transporter.sendMail({
      from: config.from,
      to: candidate.email,
      subject: message.subject,
      text: message.text,
      html: message.html,
    });
    await markEmailNotificationSent(candidate.username, kind);
  } catch (e) {
    await releaseEmailNotificationClaim(candidate.username, kind, e);
  }
}

export async function maybeSendGodScoreNotification(
  username: string,
  meta: RoastMeta,
  report: string,
): Promise<void> {
  if (meta.tier !== "夯") return;
  await sendEmailNotification(username, "god_score", report);
}

export async function maybeSendHeatTop20Notification(
  username: string,
  report?: string,
): Promise<void> {
  if (!emailAutomationEnabled()) return;
  const normalizedUsername = username.toLowerCase();
  const topHeat = await getHeatLeaderboard(20, 0);
  const inTop20 = topHeat.some((entry) => entry.username.toLowerCase() === normalizedUsername);
  if (!inTop20) return;
  await sendEmailNotification(username, "heat_top_20", report);
}

export async function verifySmtpConnection(): Promise<boolean> {
  const config = smtpConfig();
  if (!config) return false;
  const transporter = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: config.auth,
  });
  await transporter.verify();
  return true;
}

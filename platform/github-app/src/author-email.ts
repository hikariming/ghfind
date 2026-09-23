import { record, installationToken, ApiError, github } from "./github";
import { scoreToLabel, LABELS } from "./review";
import { seal, unseal } from "./secrets";

export interface ScoreContext {
  score: number | null;
  percentile: { beat: number; total: number; rank: number | null } | null;
}
export function scoreContext(value: unknown): ScoreContext {
  const body = record(value);
  const pct =
    body.percentile &&
    typeof body.percentile === "object" &&
    !Array.isArray(body.percentile)
      ? record(body.percentile)
      : {};
  const valid = (x: unknown): x is number =>
    typeof x === "number" && Number.isFinite(x);
  const score =
    scoreToLabel(body.final_score) === LABELS[4]
      ? null
      : (body.final_score as number);
  const total = pct.total;
  return {
    score,
    percentile:
      score !== null &&
      valid(pct.beat) &&
      pct.beat >= 0 &&
      pct.beat <= 100 &&
      valid(total) &&
      Number.isSafeInteger(total) &&
      total > 0
        ? {
            beat: pct.beat,
            total,
            rank:
              valid(pct.rank) &&
              Number.isSafeInteger(pct.rank) &&
              pct.rank >= 1 &&
              pct.rank <= total
                ? pct.rank
                : null,
          }
        : null,
  };
}
function usableEmail(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 254 &&
    /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(value) &&
    !/@(?:users\.)?noreply\.github\.com$/i.test(value)
  );
}
export function verifiedEmail(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const row = record(item);
    if (row.primary === true && row.verified === true && usableEmail(row.email))
      return row.email;
  }
  return null;
}
// Only the account's current public profile email is used. Commit authorship
// metadata is user-supplied and does not establish ownership of an address.
export function publicEmail(value: unknown, userId: number): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const user = record(value);
  if (user.id !== userId || user.type !== "User") return null;
  return usableEmail(user.email) ? user.email : null;
}
export async function discoverPublicRecipient(
  env: Env,
  userId: number,
  login: string,
  api: ReturnType<typeof github>,
) {
  if (!/^[A-Za-z0-9-]+$/.test(login)) return;
  if (
    await env.DB.prepare("SELECT 1 FROM author_email_optouts WHERE user_id=?")
      .bind(userId)
      .first()
  )
    return;
  if (
    await env.DB.prepare("SELECT 1 FROM author_subscriptions WHERE user_id=?")
      .bind(userId)
      .first()
  )
    return;
  let email: string | null;
  try {
    email = publicEmail(
      await api(`/users/${encodeURIComponent(login)}`),
      userId,
    );
  } catch {
    return;
  } // Email lookup must not fail completed labeling/commenting.
  if (!email) return;
  await env.DB.prepare(
    `INSERT OR IGNORE INTO author_subscriptions(user_id,login,email,locale,unsubscribe,updated,source)
     SELECT ?,?,?,'en',?,?,'public' WHERE NOT EXISTS(SELECT 1 FROM author_email_optouts WHERE user_id=?)`,
  )
    .bind(
      userId,
      login,
      await seal(env, email),
      crypto.randomUUID(),
      Date.now(),
      userId,
    )
    .run();
}
interface Payload extends ScoreContext {
  login: string;
  repository: string;
  number: number;
  kind: "issue" | "PR";
  installation: number;
  repositoryId: number;
}
const escape = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
export function authorEmail(
  payload: Payload,
  locale: string,
  unsubscribe: string,
) {
  const zh = locale === "zh",
    label = scoreToLabel(payload.score);
  const interval =
    label === LABELS[0]
      ? "0 ≤ score < 40"
      : label === LABELS[1]
        ? "40 ≤ score < 70"
        : label === LABELS[2]
          ? "70 ≤ score < 90"
          : label === LABELS[3]
            ? "90 ≤ score ≤ 100"
            : zh
              ? "暂无有效评分"
              : "Unavailable";
  const profile = `https://ghfind.com/${zh ? "" : "en/"}u/${encodeURIComponent(payload.login)}`;
  const submission = `https://github.com/${payload.repository}/${payload.kind === "PR" ? "pull" : "issues"}/${payload.number}`;
  const pct = payload.percentile;
  const lines = zh
    ? [
        `你好 ${payload.login}，你的 ${payload.kind} 已完成 ghfind 来源评分。`,
        `提交：${payload.repository} #${payload.number} — ${submission}`,
        `分数：${payload.score === null ? "暂不可用（不等于零分）" : `${payload.score} / 100`}；区间：${interval}；标签：${label}`,
        pct
          ? `在 ghfind 已收录的 ${pct.total} 个评分账号中，超过 ${pct.beat}%。${pct.rank ? `站内评分排名：第 ${pct.rank} 名。` : ""}`
          : "站内排名数据暂不可用。",
        `查看贡献背景与评分细节：${profile}`,
        "分数来自公开 GitHub 记录，不是对本次提交内容的评价。站内评分排名不是这个仓库的 PR 审查顺序，也不能预测 review 等待时间。",
        "你在安装了 ghfind Review 的仓库提交了 issue 或 PR，因此收到本次评分通知。收件地址来自你的 GitHub 公开邮箱或你主动授权的邮箱；每 72 小时最多一封，跨仓库也只算一封。不希望继续接收，请退订。",
        `退订：${unsubscribe}`,
      ]
    : [
        `Hi ${payload.login}, ghfind has scored your public profile for your ${payload.kind}.`,
        `Submission: ${payload.repository} #${payload.number} — ${submission}`,
        `Score: ${payload.score === null ? "Unavailable (not zero)" : `${payload.score} / 100`}; interval: ${interval}; label: ${label}`,
        pct
          ? `Your score exceeds ${pct.beat}% of ${pct.total} scored accounts indexed by ghfind.${pct.rank ? ` Site score rank: #${pct.rank}.` : ""}`
          : "Site ranking data is currently unavailable.",
        `Explore your contribution background and score: ${profile}`,
        "This score reflects public GitHub history, not this submission's quality. Site score rank is not the repository's PR review order and cannot predict review waiting time.",
        "You received this score notification because you opened an issue or PR in a repository using ghfind Review. We used your public GitHub email or an address you explicitly authorized. At most one email per 72 hours across repositories; unsubscribe below to stop future notifications.",
        `Unsubscribe: ${unsubscribe}`,
      ];
  return {
    subject: zh
      ? `你的 ghfind 评分 · ${payload.repository} #${payload.number}`
      : `Your ghfind score · ${payload.repository} #${payload.number}`,
    text: lines.join("\n\n"),
    html: `<html lang="${zh ? "zh" : "en"}"><body>${lines.map((line) => `<p>${escape(line)}</p>`).join("")}<p><a href="${escape(profile)}">${zh ? "查看我的 ghfind profile" : "View my ghfind profile"}</a> · <a href="${escape(unsubscribe)}">${zh ? "退订" : "Unsubscribe"}</a></p></body></html>`,
  };
}
export async function enqueueAuthorEmail(
  env: Env,
  userId: number,
  payload: Payload,
  repositoryId: number,
  api?: ReturnType<typeof github>,
) {
  if (env.EMAIL_ENABLED !== "true") return;
  if (api) await discoverPublicRecipient(env, userId, payload.login, api);
  // The logical subject is stable across webhook redeliveries and retries.
  await env.DB.prepare(
    `INSERT OR IGNORE INTO author_emails(id,user_id,payload,created,updated)
    SELECT ?,?,?,?,? WHERE EXISTS(SELECT 1 FROM author_subscriptions WHERE user_id=?)
    AND NOT EXISTS(SELECT 1 FROM author_email_optouts WHERE user_id=?)`,
  )
    .bind(
      `${repositoryId}:${payload.number}:${userId}`,
      userId,
      JSON.stringify(payload),
      Date.now(),
      Date.now(),
      userId,
      userId,
    )
    .run();
}
const EMAIL_QUIET_MS = 72 * 60 * 60 * 1000;
export async function sendAuthorEmails(env: Env) {
  if (env.EMAIL_ENABLED !== "true" || env.ENABLED !== "true") return;
  await env.DB.prepare("DELETE FROM author_emails WHERE created<?")
    .bind(Date.now() - 30 * 86400_000)
    .run();
  // A process lost after sending is uncertain, never blindly resent.
  await env.DB.prepare(
    "UPDATE author_emails SET state='uncertain',updated=? WHERE state='sending' AND updated<?",
  )
    .bind(Date.now(), Date.now() - 10 * 60_000)
    .run();
  const { results } = await env.DB.prepare(
    "SELECT id,user_id,payload FROM author_emails WHERE state='pending' ORDER BY created LIMIT 10",
  ).all<{ id: string; user_id: number; payload: string }>();
  for (const row of results) {
    const claimed = await env.DB.prepare(
      "UPDATE author_emails SET state='sending',updated=? WHERE id=? AND state='pending' RETURNING id",
    )
      .bind(Date.now(), row.id)
      .first();
    if (!claimed) continue;
    const eligible = await env.DB.prepare(
      "SELECT 1 FROM author_subscriptions WHERE user_id=? AND last_sent<? AND NOT EXISTS(SELECT 1 FROM author_email_optouts o WHERE o.user_id=author_subscriptions.user_id)",
    )
      .bind(row.user_id, Date.now() - EMAIL_QUIET_MS)
      .first();
    if (!eligible) {
      await env.DB.prepare(
        "UPDATE author_emails SET state='cancelled',updated=? WHERE id=?",
      )
        .bind(Date.now(), row.id)
        .run();
      continue;
    }
    const budget = await env.DB.prepare(
      `INSERT INTO email_daily_budget(day,used) VALUES(?,1)
      ON CONFLICT(day) DO UPDATE SET used=used+1 WHERE used<100 RETURNING used`,
    )
      .bind(new Date().toISOString().slice(0, 10))
      .first();
    if (!budget) {
      await env.DB.prepare(
        "UPDATE author_emails SET state='pending',updated=? WHERE id=?",
      )
        .bind(Date.now(), row.id)
        .run();
      break;
    }
    // One email per author across repositories until the 48-hour quiet period ends.
    const sub = await env.DB.prepare(
      `UPDATE author_subscriptions SET last_sent=? WHERE user_id=? AND last_sent<? RETURNING email,locale,unsubscribe,source`,
    )
      .bind(Date.now(), row.user_id, Date.now() - EMAIL_QUIET_MS)
      .first<{
        email: string;
        locale: string;
        unsubscribe: string;
        source: string;
      }>();
    if (!sub) {
      await env.DB.prepare(
        "UPDATE author_emails SET state='cancelled',updated=? WHERE id=?",
      )
        .bind(Date.now(), row.id)
        .run();
      continue;
    }
    try {
      const payload = JSON.parse(row.payload) as Payload;
      // Revalidate installation access before disclosing repository context.
      const token = await installationToken(
        env,
        payload.installation,
        payload.repositoryId,
        Date.now() + 30_000,
      );
      if (sub.source === "public") {
        const currentEmail = publicEmail(
          await github(token)(`/users/${encodeURIComponent(payload.login)}`),
          row.user_id,
        );
        if (!currentEmail || currentEmail !== (await unseal(env, sub.email))) {
          await env.DB.prepare(
            "UPDATE author_emails SET state='cancelled',updated=? WHERE id=?",
          )
            .bind(Date.now(), row.id)
            .run();
          await env.DB.prepare(
            "DELETE FROM author_subscriptions WHERE user_id=? AND source='public' AND unsubscribe=?",
          )
            .bind(row.user_id, sub.unsubscribe)
            .run();
          continue;
        }
      }
      const active = await env.DB.prepare(
        "SELECT 1 FROM author_subscriptions WHERE user_id=? AND unsubscribe=? AND NOT EXISTS(SELECT 1 FROM author_email_optouts o WHERE o.user_id=author_subscriptions.user_id)",
      )
        .bind(row.user_id, sub.unsubscribe)
        .first();
      if (!active) {
        await env.DB.prepare(
          "UPDATE author_emails SET state='cancelled',updated=? WHERE id=?",
        )
          .bind(Date.now(), row.id)
          .run();
        continue;
      }
      const unsubscribe = `https://bot.ghfind.com/notifications/unsubscribe?token=${sub.unsubscribe}`;
      const content = authorEmail(payload, sub.locale, unsubscribe);
      const receipt = await env.EMAIL.send({
        to: await unseal(env, sub.email),
        from: { email: env.EMAIL_FROM, name: "ghfind Review" },
        ...content,
        headers: {
          "List-Unsubscribe": `<${unsubscribe}>`,
          "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
        },
      });
      await env.DB.prepare(
        "UPDATE author_emails SET state='sent',provider_id=?,updated=? WHERE id=?",
      )
        .bind(receipt.messageId, Date.now(), row.id)
        .run();
    } catch (error) {
      // Neither addresses nor provider exceptions (which can include recipients) are logged.
      const candidate =
        error && typeof error === "object" && "code" in error
          ? error.code
          : null;
      const code =
        error instanceof ApiError
          ? `GITHUB_${error.status}`
          : typeof candidate === "string" && /^E_[A-Z_]{1,80}$/.test(candidate)
            ? candidate
            : "SEND_RESULT_UNKNOWN";
      await env.DB.prepare(
        "UPDATE author_emails SET state='uncertain',error_code=?,updated=? WHERE id=?",
      )
        .bind(code, Date.now(), row.id)
        .run();
    }
  }
  await env.DB.prepare("DELETE FROM email_daily_budget WHERE day<?")
    .bind(new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10))
    .run();
  await env.DB.prepare(
    "DELETE FROM author_emails WHERE state != 'pending' AND updated<?",
  )
    .bind(Date.now() - 30 * 86400_000)
    .run();
}

import { SITE_URL } from "@/lib/site";

/**
 * Operator alert: a campaign participant just generated their first brag card.
 * Sends the material-card link + profile link to the event operator's mailbox
 * so cards can be collected (e.g. printed on site) without watching the board.
 *
 * Delivery is via Resend's HTTP API — no SDK dependency. Configuration lives in
 * env so the recipient address never enters the public repo:
 *   RESEND_API_KEY            required
 *   CAMPAIGN_CARD_NOTIFY_TO   required (operator mailbox)
 *   CAMPAIGN_CARD_NOTIFY_FROM optional, defaults to Resend's shared onboarding
 *                             sender which works without a verified domain.
 *
 * Never throws: a mail hiccup must not affect the scan path.
 */
export async function notifyCampaignCardGenerated(
  campaign: string,
  username: string,
): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  const to = process.env.CAMPAIGN_CARD_NOTIFY_TO;
  if (!apiKey || !to) {
    console.warn(
      "campaign card notify skipped: RESEND_API_KEY / CAMPAIGN_CARD_NOTIFY_TO not configured",
    );
    return;
  }
  const from = process.env.CAMPAIGN_CARD_NOTIFY_FROM ?? "GHFind <onboarding@resend.dev>";

  // preview=1 serves no-store, so the link always shows the freshest card.
  const cardUrl = `${SITE_URL}/api/material-card/${username}?theme=dark&preview=1`;
  const profileUrl = `${SITE_URL}/u/${username}?campaign=${campaign}`;

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from,
        to: [to],
        subject: `[${campaign}] @${username} 生成了新的炫耀卡`,
        html: [
          `<p><strong>@${username}</strong> 刚在 ${campaign} 活动生成了炫耀卡。</p>`,
          `<p>炫耀卡图片（打开链接）：<br/><a href="${cardUrl}">${cardUrl}</a></p>`,
          `<p>活动详情页：<br/><a href="${profileUrl}">${profileUrl}</a></p>`,
        ].join("\n"),
        text: [
          `@${username} 刚在 ${campaign} 活动生成了炫耀卡。`,
          `炫耀卡图片（打开链接）：${cardUrl}`,
          `活动详情页：${profileUrl}`,
        ].join("\n"),
      }),
    });
    if (!res.ok) {
      console.error(
        `campaign card notify failed: ${res.status} ${await res.text().catch(() => "")}`,
      );
    }
  } catch (e) {
    console.error("campaign card notify failed:", e);
  }
}

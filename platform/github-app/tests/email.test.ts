import { env } from "cloudflare:test";
import { beforeAll, beforeEach, afterEach, expect, it, vi } from "vitest";
import {
  authorEmail,
  publicEmail,
  discoverPublicRecipient,
  scoreContext,
  verifiedEmail,
  enqueueAuthorEmail,
  sendAuthorEmails,
} from "../src/author-email";
import { seal } from "../src/secrets";
import { ui } from "../src/ui";
declare const TEST_SQL: string[];
const e = env as Env;
const payload = {
  login: "octocat",
  repository: "owner/repo",
  number: 1,
  kind: "PR" as const,
  score: 82.7,
  percentile: { beat: 91.2, total: 1000, rank: 88 },
  installation: 1,
  repositoryId: 2,
};
beforeAll(async () => {
  for (const sql of TEST_SQL) await e.DB.prepare(sql).run();
});
beforeEach(async () => {
  await e.DB.batch(
    [
      "author_email_optouts",
      "author_emails",
      "author_subscriptions",
      "email_daily_budget",
      "author_comment_once",
      "noscore_comment_budget",
      "sessions",
    ].map((t) => e.DB.prepare(`DELETE FROM ${t}`)),
  );
});
afterEach(() => vi.restoreAllMocks());
it("requires verified primary email and rejects GitHub noreply", () => {
  expect(
    verifiedEmail([{ email: "a@example.com", verified: true, primary: true }]),
  ).toBe("a@example.com");
  for (const value of [
    [{ email: "a@example.com", primary: true, verified: false }],
    [{ email: "a@users.noreply.github.com", primary: true, verified: true }],
    [{ email: "a@example.com", primary: false, verified: true }],
  ])
    expect(verifiedEmail(value)).toBeNull();
});
it("does not invent percentile or rank from invalid data", () => {
  expect(scoreContext({ final_score: 82.7 })).toEqual({
    score: 82.7,
    percentile: null,
  });
  expect(scoreContext({ final_score: 82.7, percentile: null })).toEqual({
    score: 82.7,
    percentile: null,
  });
  expect(
    scoreContext({
      final_score: 82.7,
      percentile: { beat: 120, total: 100, rank: 2 },
    }).percentile,
  ).toBeNull();
  expect(
    scoreContext({
      final_score: 82.7,
      percentile: { beat: 80, total: 100, rank: 101 },
    }).percentile?.rank,
  ).toBeNull();
  expect(
    scoreContext({
      final_score: null,
      percentile: { beat: 80, total: 100, rank: 1 },
    }),
  ).toEqual({ score: null, percentile: null });
});
it("renders bilingual facts with ranking population and no review-time promise", () => {
  const english = authorEmail(
    payload,
    "en",
    "https://bot.ghfind.com/notifications/unsubscribe?token=x",
  );
  expect(english.text).toContain("91.2% of 1000 scored accounts");
  expect(english.text).toContain("not the repository's PR review order");
  expect(english.text).toContain("70 ≤ score < 90");
  const chinese = authorEmail(
    { ...payload, score: null, percentile: null },
    "zh",
    "https://example.test",
  );
  expect(chinese.text).toContain("不等于零分");
  expect(chinese.text).toContain("站内排名数据暂不可用");
  expect(
    authorEmail(
      { ...payload, repository: "<script>/" },
      "en",
      "https://example.test",
    ).html,
  ).not.toContain("<script>");
});
async function subscribe() {
  await e.DB.prepare(
    "INSERT INTO author_subscriptions(user_id,login,email,locale,unsubscribe,updated) VALUES(1,'octocat',?,'en',?,?)",
  )
    .bind(
      await seal(e, "controlled@example.com"),
      crypto.randomUUID(),
      Date.now(),
    )
    .run();
}
it("queues only subscribers and deduplicates replayed subjects", async () => {
  const enabled = { ...e, EMAIL_ENABLED: "true" };
  await enqueueAuthorEmail(enabled, 1, payload, 2);
  expect(
    await e.DB.prepare("SELECT count(*) n FROM author_emails").first("n"),
  ).toBe(0);
  await subscribe();
  await enqueueAuthorEmail(enabled, 1, payload, 2);
  await enqueueAuthorEmail(enabled, 1, payload, 2);
  expect(
    await e.DB.prepare("SELECT count(*) n FROM author_emails").first("n"),
  ).toBe(1);
});
for (const kind of ["issue", "PR"] as const) {
  it.each([0, 20, 39.99])(
    `suppresses ${kind} email below 40 before recipient discovery`,
    async (score) => {
      const enabled = { ...e, EMAIL_ENABLED: "true" };
      const api = vi.fn();
      await enqueueAuthorEmail(enabled, 1, { ...payload, kind, score }, 2, api);
      expect(api).not.toHaveBeenCalled();
      expect(
        await e.DB.prepare("SELECT count(*) n FROM author_subscriptions").first("n"),
      ).toBe(0);
      await subscribe();
      await enqueueAuthorEmail(enabled, 1, { ...payload, kind, score }, 2, api);
      expect(
        await e.DB.prepare("SELECT count(*) n FROM author_emails").first("n"),
      ).toBe(0);
    },
  );
  it.each([40, 40.01, 100, null])(
    `preserves ${kind} email delivery for score %s`,
    async (score) => {
      await subscribe();
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        Response.json({ token: "installation-token" }),
      );
      const send = vi.fn().mockResolvedValue({ messageId: "test" });
      const enabled = { ...e, EMAIL_ENABLED: "true", EMAIL: { send } as SendEmail };
      await enqueueAuthorEmail(enabled, 1, { ...payload, kind, score }, 2);
      await sendAuthorEmails(enabled);
      expect(send).toHaveBeenCalledTimes(1);
      expect(
        await e.DB.prepare("SELECT state FROM author_emails").first("state"),
      ).toBe("sent");
    },
  );
  it.each([0, 39.99])(
    `cancels pre-existing low-score ${kind} mail without consuming delivery limits`,
    async (score) => {
      await subscribe();
      const send = vi.fn();
      const fetch = vi.spyOn(globalThis, "fetch");
      const enabled = { ...e, EMAIL_ENABLED: "true", EMAIL: { send } as SendEmail };
      await e.DB.prepare(
        "INSERT INTO author_emails(id,user_id,payload,created,updated) VALUES('legacy',1,?,?,?)",
      )
        .bind(JSON.stringify({ ...payload, kind, score }), Date.now(), Date.now())
        .run();
      await sendAuthorEmails(enabled);
      expect(send).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
      expect(
        await e.DB.prepare("SELECT state FROM author_emails").first("state"),
      ).toBe("cancelled");
      expect(
        await e.DB.prepare("SELECT last_sent FROM author_subscriptions").first("last_sent"),
      ).toBe(0);
      expect(
        await e.DB.prepare("SELECT count(*) n FROM email_daily_budget").first("n"),
      ).toBe(0);
    },
  );
}
it("sends once across concurrent drains and caps an author to one per day", async () => {
  await subscribe();
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    Response.json({ token: "installation-token" }),
  );
  const send = vi.fn().mockResolvedValue({ messageId: "test" });
  const enabled = { ...e, EMAIL_ENABLED: "true", EMAIL: { send } as SendEmail };
  await enqueueAuthorEmail(enabled, 1, payload, 2);
  await enqueueAuthorEmail(enabled, 1, { ...payload, number: 2 }, 2);
  await Promise.all([sendAuthorEmails(enabled), sendAuthorEmails(enabled)]);
  expect(send).toHaveBeenCalledTimes(1);
  expect(
    await e.DB.prepare(
      "SELECT provider_id FROM author_emails WHERE state='sent'",
    ).first("provider_id"),
  ).toBe("test");
  expect(send.mock.calls[0][0].text).toContain("82.7 / 100");
});
it("sends one email across repositories and stays quiet for 72 hours", async () => {
  await subscribe();
  vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
    Response.json({ token: "installation-token" }),
  );
  const send = vi.fn().mockResolvedValue({ messageId: "test" });
  const enabled = { ...e, EMAIL_ENABLED: "true", EMAIL: { send } as SendEmail };
  await enqueueAuthorEmail(enabled, 1, payload, 2);
  await sendAuthorEmails(enabled);
  await enqueueAuthorEmail(
    enabled,
    1,
    { ...payload, number: 9, repository: "other/repo", repositoryId: 9 },
    9,
  );
  await sendAuthorEmails(enabled);
  expect(send).toHaveBeenCalledTimes(1);
  expect(
    await e.DB.prepare("SELECT state FROM author_emails WHERE id='9:9:1'").first(
      "state",
    ),
  ).toBe("cancelled");
  await e.DB.prepare(
    "UPDATE author_subscriptions SET last_sent=? WHERE user_id=1",
  )
    .bind(Date.now() - 71 * 60 * 60 * 1000)
    .run();
  await e.DB.prepare(
    "UPDATE author_emails SET state='pending',updated=? WHERE id='9:9:1'",
  )
    .bind(Date.now())
    .run();
  await sendAuthorEmails(enabled);
  expect(send).toHaveBeenCalledTimes(1);
  await e.DB.prepare(
    "UPDATE author_subscriptions SET last_sent=? WHERE user_id=1",
  )
    .bind(Date.now() - 73 * 60 * 60 * 1000)
    .run();
  await e.DB.prepare(
    "UPDATE author_emails SET state='pending',updated=? WHERE id='9:9:1'",
  )
    .bind(Date.now())
    .run();
  await sendAuthorEmails(enabled);
  expect(send).toHaveBeenCalledTimes(2);
});
it("does not resend after an ambiguous provider failure", async () => {
  await subscribe();
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    Response.json({ token: "installation-token" }),
  );
  const send = vi.fn().mockRejectedValue(new Error("ambiguous response"));
  const enabled = { ...e, EMAIL_ENABLED: "true", EMAIL: { send } as SendEmail };
  await enqueueAuthorEmail(enabled, 1, payload, 2);
  await sendAuthorEmails(enabled);
  await sendAuthorEmails(enabled);
  expect(send).toHaveBeenCalledTimes(1);
  expect(
    await e.DB.prepare("SELECT state FROM author_emails").first("state"),
  ).toBe("uncertain");
});
it("unsubscribe GET is safe for link scanners; POST deletes subscription and cancels mail", async () => {
  await subscribe();
  const token = await e.DB.prepare(
    "SELECT unsubscribe FROM author_subscriptions",
  ).first<string>("unsubscribe");
  const enabled = { ...e, EMAIL_ENABLED: "true" };
  await enqueueAuthorEmail(enabled, 1, payload, 2);
  const url = `https://bot.ghfind.com/notifications/unsubscribe?token=${token}`;
  expect((await ui(new Request(url), enabled)).status).toBe(200);
  expect(
    await e.DB.prepare("SELECT count(*) n FROM author_subscriptions").first(
      "n",
    ),
  ).toBe(1);
  await ui(new Request(url, { method: "POST" }), enabled);
  expect(
    await e.DB.prepare("SELECT count(*) n FROM author_subscriptions").first(
      "n",
    ),
  ).toBe(0);
  expect(
    await e.DB.prepare("SELECT state FROM author_emails").first("state"),
  ).toBe("cancelled");
});
it("requires same-origin consent and stores only an encrypted verified address", async () => {
  const id = crypto.randomUUID();
  await e.DB.prepare("INSERT INTO sessions(id,value,expires) VALUES(?,?,?)")
    .bind(`session:${id}`, await seal(e, "user-token"), Date.now() + 60000)
    .run();
  const fetch = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input) => {
      if (String(input).endsWith("/user/emails"))
        return Response.json([
          { email: "controlled@example.com", primary: true, verified: true },
        ]);
      return Response.json({ id: 1, login: "octocat" });
    });
  const headers = {
    cookie: `ghfind_bot_session=${id}`,
    origin: "https://bot.ghfind.com",
    "content-type": "application/x-www-form-urlencoded",
  };
  const enabled = { ...e, EMAIL_ENABLED: "true" };
  const url = "https://bot.ghfind.com/notifications";
  const page = await ui(new Request(url, { headers }), enabled);
  expect(page.headers.get("Referrer-Policy")).toBe("same-origin");
  expect(
    await e.DB.prepare("SELECT count(*) n FROM author_subscriptions").first(
      "n",
    ),
  ).toBe(0);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(
    (
      await ui(
        new Request(url, {
          method: "POST",
          headers: { ...headers, origin: "https://other.test" },
          body: `csrf=${id}&consent=yes`,
        }),
        enabled,
      )
    ).status,
  ).toBe(403);
  expect(
    (
      await ui(
        new Request(url, { method: "POST", headers, body: `csrf=${id}` }),
        enabled,
      )
    ).status,
  ).toBe(400);
  expect(
    (
      await ui(
        new Request(url, {
          method: "POST",
          headers,
          body: `csrf=${id}&consent=yes&locale=zh`,
        }),
        enabled,
      )
    ).status,
  ).toBe(303);
  const sub = await e.DB.prepare(
    "SELECT email,locale FROM author_subscriptions",
  ).first<{ email: string; locale: string }>();
  expect(sub?.email).not.toContain("controlled@example.com");
  expect(sub?.locale).toBe("zh");
});
it("stops sending when disabled, the global budget is exhausted, or access is revoked", async () => {
  await subscribe();
  const send = vi.fn();
  const enabled = { ...e, EMAIL_ENABLED: "true", EMAIL: { send } as SendEmail };
  await enqueueAuthorEmail(enabled, 1, payload, 2);
  await sendAuthorEmails({ ...enabled, EMAIL_ENABLED: "false" });
  expect(send).not.toHaveBeenCalled();
  await e.DB.prepare("INSERT INTO email_daily_budget(day,used) VALUES(?,100)")
    .bind(new Date().toISOString().slice(0, 10))
    .run();
  await sendAuthorEmails(enabled);
  expect(send).not.toHaveBeenCalled();
  expect(
    await e.DB.prepare("SELECT state FROM author_emails").first("state"),
  ).toBe("pending");
  await e.DB.prepare("DELETE FROM email_daily_budget").run();
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response("", { status: 404 }),
  );
  await sendAuthorEmails(enabled);
  expect(send).not.toHaveBeenCalled();
});

it("discovers a public profile address without opt-in and persists opt-out across new subjects", async () => {
  const enabled = { ...e, EMAIL_ENABLED: "true" };
  const api = vi
    .fn()
    .mockResolvedValue({
      id: 1,
      type: "User",
      email: "controlled@example.com",
    });
  await enqueueAuthorEmail(enabled, 1, payload, 2, api);
  expect(
    await e.DB.prepare("SELECT source FROM author_subscriptions").first(
      "source",
    ),
  ).toBe("public");
  expect(
    await e.DB.prepare("SELECT count(*) n FROM author_emails").first("n"),
  ).toBe(1);
  const token = await e.DB.prepare(
    "SELECT unsubscribe FROM author_subscriptions",
  ).first("unsubscribe");
  await ui(
    new Request(
      `https://bot.ghfind.com/notifications/unsubscribe?token=${token}`,
      { method: "POST" },
    ),
    enabled,
  );
  await enqueueAuthorEmail(enabled, 1, { ...payload, number: 2 }, 2, api);
  expect(
    await e.DB.prepare("SELECT count(*) n FROM author_subscriptions").first(
      "n",
    ),
  ).toBe(0);
  expect(
    await e.DB.prepare("SELECT count(*) n FROM author_emails").first("n"),
  ).toBe(1);
  expect(api).toHaveBeenCalledTimes(1);
});
it("rejects mismatched identity, bots, missing and noreply public emails", async () => {
  for (const value of [
    { id: 2, type: "User", email: "a@example.com" },
    { id: 1, type: "Bot", email: "a@example.com" },
    { id: 1, type: "User", email: null },
    { id: 1, type: "User", email: "a@users.noreply.github.com" },
  ])
    expect(publicEmail(value, 1)).toBeNull();
  const api = vi.fn().mockRejectedValue(new Error("unavailable"));
  await discoverPublicRecipient(e, 1, "octocat", api);
  expect(
    await e.DB.prepare("SELECT count(*) n FROM author_subscriptions").first(
      "n",
    ),
  ).toBe(0);
});
it("does not send when a previously public email is hidden or replaced", async () => {
  const send = vi.fn();
  const enabled = { ...e, EMAIL_ENABLED: "true", EMAIL: { send } as SendEmail };
  await enqueueAuthorEmail(
    enabled,
    1,
    payload,
    2,
    vi
      .fn()
      .mockResolvedValue({
        id: 1,
        type: "User",
        email: "controlled@example.com",
      }),
  );
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) =>
    String(input).includes("/users/")
      ? Response.json({ id: 1, type: "User", email: null })
      : Response.json({ token: "test" }),
  );
  await sendAuthorEmails(enabled);
  expect(send).not.toHaveBeenCalled();
  expect(
    await e.DB.prepare("SELECT state FROM author_emails").first("state"),
  ).toBe("cancelled");
});
it("a concurrent opt-out during public lookup prevents automatic enrollment", async () => {
  await discoverPublicRecipient(e, 1, "octocat", async () => {
    await e.DB.prepare("INSERT INTO author_email_optouts VALUES(1,?)")
      .bind(Date.now())
      .run();
    return { id: 1, type: "User", email: "controlled@example.com" };
  });
  expect(
    await e.DB.prepare("SELECT count(*) n FROM author_subscriptions").first(
      "n",
    ),
  ).toBe(0);
});

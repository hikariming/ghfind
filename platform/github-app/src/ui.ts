import { seal, unseal } from "./secrets";
import { verifiedEmail } from "./author-email";
import { github, jsonRequest, record, positive } from "./github";
import { dispatch, Job, putJob } from "./jobs";

const escape = (text: unknown) =>
  String(text).replace(
    /[&<>"']/g,
    (x) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        x
      ]!,
  );
function html(content: string) {
  return new Response(
    `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ghfind Review Bot</title><style>
  :root{color-scheme:light dark;--bg:#f7f4ed;--fg:#171717;--card:#fff;--border:#c9c5bd;--link:#934000}html[data-theme=light]{color-scheme:light}html[data-theme=dark]{color-scheme:dark;--bg:#171717;--fg:#eee;--card:#242424;--border:#626262;--link:#ffac6b}@media(prefers-color-scheme:dark){html:not([data-theme=light]){--bg:#171717;--fg:#eee;--card:#242424;--border:#626262;--link:#ffac6b}}body{background:var(--bg);color:var(--fg);font:16px/1.6 system-ui;margin:auto;max-width:900px;padding:24px}nav{display:flex;justify-content:space-between;align-items:center;gap:16px}a{color:var(--link)}button,select{font:inherit;color:var(--fg);background:var(--card);border:1px solid var(--border);padding:6px 12px;border-radius:6px;cursor:pointer}button:hover,a:hover{opacity:.8}section{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:20px;margin:20px 0;overflow-wrap:anywhere}img{vertical-align:middle;margin-right:10px}table{width:100%;border-collapse:collapse}td,th{text-align:left;padding:10px;border-bottom:1px solid var(--border)}.table{overflow:auto}:focus-visible{outline:3px solid var(--link);outline-offset:3px}footer{margin-top:32px}
  </style><nav><a href="/"><img src="/avatar.png" width="40" height="40" alt="ghfind">ghfind Review</a><label>Theme <select id="theme" aria-label="Theme"><option value="auto">Auto</option><option value="light">Light</option><option value="dark">Dark</option></select></label></nav>${content}<footer><a href="https://github.com/hikariming/ghfind">Source & support</a> · <a href="/privacy">Privacy</a></footer><script src="/theme.js"></script></html>`,
    {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        // Preserve Origin on native same-origin form POSTs; suppress cross-site referrers.
        "Referrer-Policy": "same-origin",
        "Content-Security-Policy":
          "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; script-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
      },
    },
  );
}
const cookie = (request: Request, name: string) =>
  request.headers
    .get("cookie")
    ?.split(";")
    .map((x) => x.trim())
    .find((x) => x.startsWith(`${name}=`))
    ?.slice(name.length + 1);
const cookieHeader = (name: string, value: string, maxAge: number) =>
  `${name}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`;
function redirect(url: string, cookies?: string) {
  return new Response(null, {
    status: 303,
    headers: {
      Location: url,
      "Cache-Control": "no-store",
      ...(cookies ? { "Set-Cookie": cookies } : {}),
    },
  });
}
async function session(request: Request, env: Env) {
  const id = cookie(request, "ghfind_bot_session");
  if (!id || !/^[a-f0-9-]{36}$/.test(id)) return null;
  const row = await env.DB.prepare(
    "SELECT value FROM sessions WHERE id=? AND expires>?",
  )
    .bind(`session:${id}`, Date.now())
    .first<{ value: string }>();
  if (!row) return null;
  try {
    return { id, token: await unseal(env, row.value) };
  } catch {
    return null;
  }
}
export async function ui(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url),
    path = url.pathname;
  if (path === "/theme.js")
    return new Response(
      "const t=document.getElementById('theme');let v='auto';try{v=localStorage.getItem('ghfind-bot-theme')||v}catch{};t.value=v;document.documentElement.dataset.theme=v;t.onchange=()=>{document.documentElement.dataset.theme=t.value;try{localStorage.setItem('ghfind-bot-theme',t.value)}catch{}}",
      {
        headers: {
          "Content-Type": "text/javascript",
          "Cache-Control": "public,max-age=3600",
        },
      },
    );
  if (path === "/" && request.method === "GET")
    return html(
      `<h1>Review labels and profiles for issues and PRs.</h1><section><p>Install ghfind Review and choose repositories. We create five review-level labels, preserve your existing label settings, and label new issues and pull requests using the author's ghfind score, and post a comment with their profile, score and score interval.</p><p>${env.APP_SLUG && env.ENABLED === "true" ? `<a href="https://github.com/apps/${encodeURIComponent(env.APP_SLUG)}/installations/new">Install GitHub App</a>` : "Installation is not open yet."}</p><p>Issues and pull requests write permissions are requested. We do not read source files or run pull request code. Disable the old PR review level workflow when switching to this App.</p><p><a href="/notifications">Author email notifications / 作者邮件通知</a></p><p>Current rollout: ${escape(env.ALLOWED_ACCOUNTS === "*" ? "All accounts" : env.ALLOWED_ACCOUNTS)}.</p></section><section><h2>Labels</h2><p>review: low 0–39.99 · medium 40–69.99 · high 70–89.99 · top 90–100 · no-score when the score could not be obtained.</p><p>The score describes an author's public GitHub profile; it is not a code review or a merge decision.</p></section>`,
    );
  if (path === "/privacy")
    return html(
      "<h1>Privacy</h1><section><p>GitHub sends installation, issue, pull request and issue comment events. Comment text is checked only for an admin mention of this App and is not stored. We verify events and retain only installation/repository IDs, repository names, issue/PR numbers and task status. Author login is sent to ghfind to retrieve a public-profile score. Issue/PR text and code are not stored or sent for scoring. The author profile link and score are posted as a comment after labeling.</p><p>Completed task records expire after 30 days. Failed task records remain until an operator resolves them. Dashboard sessions expire after one hour; GitHub user tokens are encrypted at rest. Uninstalling the App stops repository access and leaves existing labels in place.</p><p>Author score emails are enabled by default when a current public GitHub profile email is available. We do not use commit emails. Users may alternatively authorize their verified primary email. Addresses are encrypted at rest. Email records retain author and submission metadata for 30 days. Unsubscribe removes the stored email, cancels pending mail, and retains the GitHub user ID as a persistent opt-out so new submissions cannot resubscribe the author; a send already in progress may complete. Delivery-uncertain messages are not automatically resent.</p><p>For deletion requests, contact the maintainers through the source repository.</p></section>",
    );
  if (path === "/notifications/unsubscribe") {
    const token = url.searchParams.get("token") ?? "";
    if (!/^[a-f0-9-]{36}$/.test(token))
      return new Response("Invalid link", { status: 400 });
    if (request.method === "POST") {
      await env.DB.batch([
        env.DB.prepare(
          "INSERT OR IGNORE INTO author_email_optouts(user_id,updated) SELECT user_id,? FROM author_subscriptions WHERE unsubscribe=?",
        ).bind(Date.now(), token),
        env.DB.prepare(
          "UPDATE author_emails SET state='cancelled',updated=? WHERE state='pending' AND user_id IN (SELECT user_id FROM author_subscriptions WHERE unsubscribe=?)",
        ).bind(Date.now(), token),
        env.DB.prepare(
          "DELETE FROM author_subscriptions WHERE unsubscribe=?",
        ).bind(token),
      ]);
      return html(
        "<h1>Unsubscribed / 已退订</h1><p>Your email subscription has been removed. / 已删除邮箱订阅。</p>",
      );
    }
    if (request.method !== "GET")
      return new Response("Method not allowed", { status: 405 });
    return html(
      `<h1>Unsubscribe / 退订</h1><form method="post"><button>Stop author emails / 停止作者邮件</button></form>`,
    );
  }
  if (path === "/notifications") {
    if (env.EMAIL_ENABLED !== "true")
      return html(
        "<h1>Author emails / 作者邮件</h1><p>Email notifications are not enabled yet. / 邮件通知暂未开放。</p>",
      );
    const current = await session(request, env);
    if (!current)
      return html(
        '<h1>Your ghfind score, in your inbox / 邮箱里的 ghfind 评分</h1><section><p>Authors with a public GitHub profile email receive score notifications by default, until they unsubscribe. At most one per 48 hours across repositories. Sign in to use your verified email or manage preferences. / 有 GitHub 公开邮箱的作者默认收到评分通知，退订后停止，跨仓库每 48 小时最多一封。登录可改用已验证邮箱或管理偏好。</p><p>GitHub authorization reads your verified primary email. Signing in alone does not subscribe you. / GitHub 授权用于读取已验证主邮箱，仅登录不会订阅。</p><a href="/login?return_to=notifications">Sign in with GitHub / 使用 GitHub 登录</a></section>',
      );
    const api = github(current.token);
    const user = record(await api("/user"));
    const userId = positive(user.id);
    if (typeof user.login !== "string" || !/^[A-Za-z0-9-]+$/.test(user.login))
      return new Response("Invalid user", { status: 400 });
    if (request.method === "POST") {
      if (request.headers.get("origin") !== url.origin)
        return new Response("Invalid origin", { status: 403 });
      const form = new URLSearchParams(await readTextBounded(request));
      if (form.get("csrf") !== current.id || form.get("consent") !== "yes")
        return new Response("Consent required", { status: 400 });
      let email: string | null;
      try {
        email = verifiedEmail(await api("/user/emails"));
      } catch {
        return html(
          '<h1>Email authorization needed / 需要邮箱授权</h1><p>Authorize Email addresses: read for ghfind Review, then sign in again. / 请为 ghfind Review 授权读取邮箱，然后重新登录。</p><a href="/login?return_to=notifications">Sign in again / 重新登录</a>',
        );
      }
      if (!email)
        return html(
          "<h1>No verified primary email / 无已验证主邮箱</h1><p>Verify your primary email in GitHub settings and try again. / 请在 GitHub 设置中验证主邮箱后重试。</p>",
        );
      await env.DB.batch([
        env.DB.prepare("DELETE FROM author_email_optouts WHERE user_id=?").bind(
          userId,
        ),
        env.DB.prepare(
          `INSERT INTO author_subscriptions(user_id,login,email,locale,unsubscribe,updated) VALUES(?,?,?,?,?,?)
        ON CONFLICT(user_id) DO UPDATE SET login=excluded.login,email=excluded.email,locale=excluded.locale,updated=excluded.updated,source='verified'`,
        ).bind(
          userId,
          user.login,
          await seal(env, email),
          form.get("locale") === "zh" ? "zh" : "en",
          crypto.randomUUID(),
          Date.now(),
        ),
      ]);
      return redirect("/notifications");
    }
    if (request.method !== "GET")
      return new Response("Method not allowed", { status: 405 });
    const sub = await env.DB.prepare(
      "SELECT locale,unsubscribe FROM author_subscriptions WHERE user_id=?",
    )
      .bind(userId)
      .first<{ locale: string; unsubscribe: string }>();
    return html(
      `<h1>Author email preferences / 作者邮件设置</h1><section><p>${escape(user.login)} · ${sub ? "Subscribed / 已订阅" : "Not subscribed / 未订阅"}</p><p>Receive your public-profile score and ghfind ranking for new issues/PRs. This is not a review-time estimate. / 接收新 issue 或 PR 的公开评分及站内排名，不代表审查等待时间。</p><form method="post"><input type="hidden" name="csrf" value="${current.id}"><p><label>Language / 语言 <select name="locale"><option value="en">English</option><option value="zh" ${sub?.locale === "zh" ? "selected" : ""}>中文</option></select></label></p><p><label><input type="checkbox" name="consent" value="yes" required> I agree to receive author notifications at my GitHub verified primary email, at most once per 48 hours across repositories. / 我同意通过 GitHub 已验证主邮箱接收作者通知，跨仓库每 48 小时最多一封。</label></p><button>Save subscription / 保存订阅</button></form>${sub ? `<p><a href="/notifications/unsubscribe?token=${sub.unsubscribe}">Unsubscribe / 退订</a></p>` : ""}</section>`,
    );
  }
  if (path === "/login" && request.method === "GET") {
    const installation =
      url.searchParams.get("return_to") === "notifications"
        ? "notifications"
        : url.searchParams.get("installation_id");
    if (
      !installation ||
      (installation !== "notifications" && !/^\d{1,16}$/.test(installation)) ||
      !env.APP_CLIENT_ID
    )
      return new Response("Invalid installation", { status: 400 });
    const state = crypto.randomUUID();
    await env.DB.prepare("INSERT INTO sessions(id,value,expires) VALUES(?,?,?)")
      .bind(`oauth:${state}`, installation, Date.now() + 10 * 60_000)
      .run();
    const params = new URLSearchParams({
      client_id: env.APP_CLIENT_ID,
      redirect_uri: `${url.origin}/callback`,
      state,
    });
    return redirect(
      `https://github.com/login/oauth/authorize?${params}`,
      cookieHeader("ghfind_bot_state", state, 600),
    );
  }
  if (path === "/callback" && request.method === "GET") {
    const state = url.searchParams.get("state"),
      code = url.searchParams.get("code");
    if (!state || !code || state !== cookie(request, "ghfind_bot_state"))
      return new Response("Invalid login state", { status: 403 });
    const row = await env.DB.prepare(
      "DELETE FROM sessions WHERE id=? AND expires>? RETURNING value",
    )
      .bind(`oauth:${state}`, Date.now())
      .first<{ value: string }>();
    if (!row) return new Response("Login expired", { status: 403 });
    const token = record(
      await jsonRequest("https://github.com/login/oauth/access_token", {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          client_id: env.APP_CLIENT_ID,
          client_secret: env.APP_CLIENT_SECRET,
          code,
          redirect_uri: `${url.origin}/callback`,
        }),
      }),
    );
    if (typeof token.access_token !== "string")
      return new Response("Login failed", { status: 403 });
    const id = crypto.randomUUID();
    await env.DB.prepare("INSERT INTO sessions(id,value,expires) VALUES(?,?,?)")
      .bind(
        `session:${id}`,
        await seal(env, token.access_token),
        Date.now() + 3600_000,
      )
      .run();
    return redirect(
      row.value === "notifications"
        ? "/notifications"
        : `/setup?installation_id=${row.value}`,
      cookieHeader("ghfind_bot_session", id, 3600),
    );
  }
  if (path === "/setup" || path === "/retry") {
    const installation = url.searchParams.get("installation_id");
    if (!installation || !/^\d{1,16}$/.test(installation))
      return html(
        "<h1>Installation status</h1><p>Open this page from your GitHub App installation settings.</p>",
      );
    const current = await session(request, env);
    if (!current)
      return html(
        `<h1>Installation received</h1><section><p>Label initialization runs automatically in the background. Sign in to see repositories and task status.</p><a href="/login?installation_id=${installation}">Sign in with GitHub</a></section>`,
      );
    const api = github(current.token);
    // The user-token endpoint intersects App installation scope with the user's
    // current access. The query parameter alone never grants access to a job.
    const repos = new Map<number, string>();
    for (let page = 1; page <= 100; page++) {
      const list = record(
        await api(
          `/user/installations/${installation}/repositories?per_page=100&page=${page}`,
        ),
      );
      if (!Array.isArray(list.repositories))
        throw new Error("Invalid repositories");
      for (const item of list.repositories) {
        const repo = record(item);
        if (typeof repo.id === "number" && typeof repo.full_name === "string")
          repos.set(repo.id, repo.full_name);
      }
      if (list.repositories.length < 100) break;
    }
    if (path === "/retry" && request.method === "POST") {
      if (request.headers.get("origin") !== url.origin)
        return new Response("Invalid origin", { status: 403 });
      const form = new URLSearchParams(await readTextBounded(request));
      if (form.get("csrf") !== current.id)
        return new Response("Invalid form", { status: 403 });
      const job = await env.DB.prepare(
        "SELECT * FROM jobs WHERE id=? AND installation=? AND state='failed'",
      )
        .bind(form.get("id"), Number(installation))
        .first<Job>();
      if (!job?.repository || !repos.has(job.repository))
        return new Response("Not found", { status: 404 });
      const repo = record(await api(`/repos/${repos.get(job.repository)}`));
      if (record(repo.permissions).admin !== true)
        return new Response("Repository admin required", { status: 403 });
      await putJob(env, { ...job, id: `retry-${crypto.randomUUID()}` });
      await dispatch(env);
      return redirect(`/setup?installation_id=${installation}`);
    }
    if (request.method !== "GET")
      return new Response("Method not allowed", { status: 405 });
    const { results } = await env.DB.prepare(
      "SELECT * FROM jobs WHERE installation=? ORDER BY updated DESC LIMIT 100",
    )
      .bind(Number(installation))
      .all<Job>();
    const visible = results.filter(
      (x) => x.repository && repos.has(x.repository),
    );
    return html(
      `<h1>Installation status</h1><p>Refresh to see progress. Only repositories you can access are shown.</p><section class="table"><table><thead><tr><th>Repository</th><th>Task</th><th>Status</th><th>Action</th></tr></thead><tbody>${visible.map((job) => `<tr><td><a href="https://github.com/${escape(repos.get(job.repository!))}/labels">${escape(repos.get(job.repository!))}</a></td><td>${escape(job.kind)}${job.pr ? ` #${job.pr}` : ""}</td><td>${escape(job.state)}${job.result ? `: ${escape(job.result)}` : ""}</td><td>${job.state === "failed" ? `<form method="post" action="/retry?installation_id=${installation}"><input type="hidden" name="csrf" value="${current.id}"><input type="hidden" name="id" value="${escape(job.id)}"><button>Retry (admin)</button></form>` : ""}</td></tr>`).join("")}</tbody></table>${!visible.length ? "<p>Initialization is being discovered, or there are no tasks for your accessible repositories yet.</p>" : ""}</section>`,
    );
  }
  return new Response("Not found", { status: 404 });
}
async function readTextBounded(request: Request) {
  const { readText } = await import("./github");
  return readText(request, AbortSignal.timeout(5000), 4096);
}

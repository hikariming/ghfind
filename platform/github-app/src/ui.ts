import { seal, unseal } from "./secrets";
import { verifiedEmail } from "./author-email";
import { github, jsonRequest, record, positive } from "./github";
import { dispatch, Job, putJob } from "./jobs";
import {
  format,
  LOCALE_COOKIE,
  LOCALE_NAMES,
  LOCALES,
  Locale,
  Messages,
  MESSAGES,
  pickLocale,
} from "./i18n";

const escape = (text: unknown) =>
  String(text).replace(
    /[&<>"']/g,
    (x) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        x
      ]!,
  );

// Same colour tokens and typeface as ghfind.com, so the bot reads as part of the site.
const STYLE = `
@font-face{font-family:"DM Sans";font-style:normal;font-weight:100 1000;font-display:swap;src:url("/fonts/dm-sans-variable.ttf") format("truetype")}
:root{--bg:#fff;--fg:#242423;--surface:#fafaf9;--muted-bg:#f3f3f1;--card:#fff;--border:#e7e7e4;--muted:#757571;--primary:#252524;--primary-fg:#fff;--link:#4167a7;--accent:#48745a;--accent-bg:#edf4ee;--shadow:0 8px 32px #2525240d;color-scheme:light}
@media(prefers-color-scheme:dark){:root:not([data-theme=light]){--bg:#141414;--fg:#eeeeec;--surface:#1b1b1b;--muted-bg:#262626;--card:#191919;--border:#333332;--muted:#a3a3a0;--primary:#ededeb;--primary-fg:#202020;--link:#a9c4f8;--accent:#89b69a;--accent-bg:#202e25;--shadow:0 12px 40px #0003;color-scheme:dark}}
:root[data-theme=dark]{--bg:#141414;--fg:#eeeeec;--surface:#1b1b1b;--muted-bg:#262626;--card:#191919;--border:#333332;--muted:#a3a3a0;--primary:#ededeb;--primary-fg:#202020;--link:#a9c4f8;--accent:#89b69a;--accent-bg:#202e25;--shadow:0 12px 40px #0003;color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;display:flex;flex-direction:column;min-height:100vh;background:var(--bg);color:var(--fg);font:14px/1.65 "DM Sans",system-ui,"PingFang SC","Microsoft YaHei",sans-serif;-webkit-font-smoothing:antialiased}
a{color:inherit;text-decoration:none}
p{margin:0}
h1,h2,h3{margin:0;font-weight:600}
.wrap{width:100%;max-width:1080px;margin:0 auto;padding:0 32px}
.top{position:sticky;top:0;z-index:5;border-bottom:1px solid var(--border);background:color-mix(in srgb,var(--bg) 88%,transparent);backdrop-filter:blur(10px)}
.top .wrap{display:flex;align-items:center;justify-content:space-between;gap:16px;min-height:60px}
.brand{display:inline-flex;align-items:center;gap:10px;white-space:nowrap;font-weight:650;font-size:15px;letter-spacing:-.2px}
.brand img{border-radius:8px}
.tools{display:flex;align-items:center;gap:8px}
.navlink{display:inline-flex;align-items:center;gap:4px;padding:6px 10px;border-radius:8px;font-size:12px;color:var(--muted)}
.navlink:hover{color:var(--fg);background:var(--muted-bg)}
select{font:inherit;font-size:12px;color:var(--fg);background:var(--card);border:1px solid var(--border);border-radius:8px;padding:6px 28px 6px 10px;cursor:pointer;appearance:none;background-image:linear-gradient(45deg,transparent 50%,var(--muted) 50%),linear-gradient(135deg,var(--muted) 50%,transparent 50%);background-position:calc(100% - 14px) 52%,calc(100% - 10px) 52%;background-size:4px 4px;background-repeat:no-repeat}
[dir=rtl] select{padding:6px 10px 6px 28px;background-position:14px 52%,10px 52%}
.theme{display:inline-flex;padding:2px;border:1px solid var(--border);border-radius:999px;background:var(--surface)}
.theme button{display:grid;place-items:center;width:26px;height:26px;border:0;border-radius:999px;background:none;color:var(--muted);cursor:pointer}
.theme button[aria-pressed=true]{background:var(--card);color:var(--fg);box-shadow:0 1px 3px #0000001f}
main.wrap{flex:1;padding-top:48px;padding-bottom:64px}
.eyebrow{display:inline-block;margin-bottom:16px;padding:3px 8px;border-radius:5px;background:var(--accent-bg);color:var(--accent);font-size:10px;font-weight:600;letter-spacing:1.4px;text-transform:uppercase}
.hero{display:grid;grid-template-columns:minmax(0,1.15fr) minmax(0,1fr);gap:48px;align-items:center;padding:24px 0 16px}
.hero h1{font-size:clamp(30px,4vw,44px);line-height:1.25;letter-spacing:-1.4px;font-weight:650}
.lead{margin-top:18px;max-width:560px;color:var(--muted);font-size:14px;line-height:1.85}
.actions{display:flex;flex-wrap:wrap;gap:10px;margin-top:26px}
.btn{display:inline-flex;align-items:center;gap:8px;padding:10px 16px;border:1px solid var(--border);border-radius:8px;background:var(--card);color:var(--fg);font:inherit;font-size:13px;font-weight:500;cursor:pointer;transition:background .15s,opacity .15s,transform .15s}
.btn:hover{background:var(--muted-bg)}
.btn.primary{background:var(--primary);border-color:var(--primary);color:var(--primary-fg)}
.btn.primary:hover{opacity:.86;transform:translateY(-1px)}
.note{margin-top:14px;font-size:12px;color:var(--muted)}
.card{border:1px solid var(--border);border-radius:15px;background:var(--card)}
.legend{overflow:hidden;box-shadow:var(--shadow)}
.legend h2{padding:14px 20px;border-bottom:1px solid var(--border);background:var(--surface);font-size:12px;color:var(--muted)}
.legend li{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:13px 20px}
.legend li+li{border-top:1px solid var(--border)}
.legend strong{font-size:14px;font-variant-numeric:tabular-nums}
.legend ul{margin:0;padding:0;list-style:none}
.label{display:inline-flex;align-items:center;border-radius:999px;padding:1px 10px;color:#1f2328;font-size:12px;font-weight:600;line-height:20px;white-space:nowrap}
.fine{margin-top:12px;font-size:12px;line-height:1.75;color:var(--muted)}
section{margin-top:52px}
section>h2{font-size:19px;letter-spacing:-.3px}
section>.sub{margin-top:6px;font-size:13px;color:var(--muted)}
.grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px;margin-top:18px}
.step{padding:22px 20px}
.step span{font-size:10px;letter-spacing:1.6px;color:var(--accent);font-weight:600}
.step h3,.info h3{margin:12px 0 6px;font-size:15px}
.step p,.info p{font-size:13px;line-height:1.8;color:var(--muted)}
.info{padding:22px;border-inline-start:3px solid var(--accent);border-radius:12px;background:var(--surface)}
.info h3{margin-top:0}
.info a{display:inline-block;margin-top:10px;font-size:13px;font-weight:600;color:var(--link)}
.page{max-width:720px}
.page h1{font-size:clamp(26px,3.4vw,34px);line-height:1.3;letter-spacing:-.8px;font-weight:650}
.page .card{margin-top:24px;padding:24px 26px}
.page .card>*+*{margin-top:14px}
.page .card p{line-height:1.85}
.muted{color:var(--muted)}
.prose p+p{margin-top:16px}
.prose p{color:var(--muted);line-height:1.9}
.status{display:inline-flex;align-items:center;gap:8px;padding:4px 10px;border-radius:999px;background:var(--muted-bg);font-size:12px;font-weight:500}
.status[data-on]{background:var(--accent-bg);color:var(--accent)}
.field{display:flex;flex-direction:column;gap:6px;font-size:12px;color:var(--muted)}
.field select{width:fit-content}
.check{display:flex;gap:10px;align-items:flex-start;font-size:13px;line-height:1.7}
.check input{margin-top:5px;accent-color:var(--accent)}
.textlink{color:var(--link);font-weight:500}
.table{margin-top:20px;overflow:auto}
table{width:100%;border-collapse:collapse;font-size:13px}
th{padding:12px 16px;text-align:start;font-size:11px;font-weight:600;letter-spacing:.3px;text-transform:uppercase;color:var(--muted);background:var(--surface);border-bottom:1px solid var(--border)}
td{padding:12px 16px;border-bottom:1px solid var(--border);vertical-align:middle}
tr:last-child td{border-bottom:0}
td a{color:var(--link)}
.pill{display:inline-block;padding:2px 9px;border-radius:999px;background:var(--muted-bg);font-size:11px;font-weight:600}
.pill[data-state=done]{background:var(--accent-bg);color:var(--accent)}
.pill[data-state=failed]{background:#fbeaea;color:#a33a3a}
:root[data-theme=dark] .pill[data-state=failed]{background:#3a2020;color:#f0a4a4}
@media(prefers-color-scheme:dark){:root:not([data-theme=light]) .pill[data-state=failed]{background:#3a2020;color:#f0a4a4}}
.result{display:block;margin-top:4px;font-size:12px;color:var(--muted)}
.table .btn{padding:6px 12px;font-size:12px}
.empty{padding:28px;text-align:center;color:var(--muted);font-size:13px}
footer{border-top:1px solid var(--border);background:var(--surface)}
footer .wrap{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:12px;padding-top:22px;padding-bottom:22px;font-size:12px;color:var(--muted)}
footer nav{display:flex;flex-wrap:wrap;gap:18px}
footer a:hover{color:var(--fg)}
:focus-visible{outline:2px solid var(--link);outline-offset:3px;border-radius:6px}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
@media(max-width:860px){.hero{grid-template-columns:1fr;gap:32px}.grid{grid-template-columns:1fr}}
@media(max-width:640px){.wrap{padding:0 16px}main.wrap{padding-top:28px}.navlink{display:none}.tools select{max-width:104px}.top .wrap{gap:10px}.hero h1{font-size:30px;letter-spacing:-1px}.page .card{padding:20px}th,td{padding:10px 12px}}
@media(prefers-reduced-motion:reduce){.btn{transition:none}.btn.primary:hover{transform:none}}
`;

const ICONS = {
  light:
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>',
  dark: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M20.5 14.5A8.5 8.5 0 0 1 9.5 3.5a8.5 8.5 0 1 0 11 11Z"/></svg>',
  auto: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/></svg>',
  external:
    '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M7 17 17 7M8 7h9v9"/></svg>',
};

/** Mirrors the label colours in review.ts; GitHub renders them as-is in both themes. */
const LEGEND = [
  ["top", "review: top", "#ded0a6"],
  ["high", "review: high", "#e2c0a2"],
  ["medium", "review: medium", "#b6dfff"],
  ["low", "review: low", "#d9dee3"],
  ["noScore", "review: no-score", "#c3c7ce"],
] as const;

/** ghfind.com serves Chinese at the root and every other locale under its prefix. */
const siteUrl = (locale: Locale, path: string) =>
  `https://ghfind.com${locale === "zh" ? "" : `/${locale}`}${path}`;

type View = { locale: Locale; t: Messages; setLocale: boolean };

function html(view: View, title: string, content: string) {
  const { locale, t } = view;
  const theme = (["light", "dark", "auto"] as const)
    .map(
      (mode) =>
        `<button type="button" data-theme-choice="${mode}" aria-pressed="false" aria-label="${escape(t.nav[mode])}" title="${escape(t.nav[mode])}">${ICONS[mode]}</button>`,
    )
    .join("");
  const languages = LOCALES.map(
    (code) =>
      `<option value="${code}"${code === locale ? " selected" : ""}>${LOCALE_NAMES[code]}</option>`,
  ).join("");
  const headers: Record<string, string> = {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Language": locale,
    Vary: "Accept-Language, Cookie",
    "X-Content-Type-Options": "nosniff",
    // Preserve Origin on native same-origin form POSTs; suppress cross-site referrers.
    "Referrer-Policy": "same-origin",
    "Content-Security-Policy":
      "default-src 'none'; img-src 'self'; font-src 'self'; style-src 'unsafe-inline'; script-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  };
  if (view.setLocale)
    headers["Set-Cookie"] =
      `${LOCALE_COOKIE}=${locale}; Path=/; Secure; SameSite=Lax; Max-Age=31536000`;
  return new Response(
    `<!doctype html><html lang="${locale}" dir="${locale === "ar" ? "rtl" : "ltr"}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)} · ghfind Review</title><link rel="icon" href="/avatar.png"><style>${STYLE}</style><script src="/theme.js"></script></head><body>
<header class="top"><div class="wrap"><a class="brand" href="/"><img src="/avatar.png" width="28" height="28" alt="">ghfind Review</a><div class="tools"><a class="navlink" href="${siteUrl(locale, "/github-bot")}">${escape(t.nav.site)}${ICONS.external}</a><label><span class="sr">${escape(t.nav.language)}</span><select id="lang">${languages}</select></label><div class="theme" role="group" aria-label="${escape(t.nav.theme)}">${theme}</div></div></div></header>
<main class="wrap">${content}</main>
<footer><div class="wrap"><span>© ghfind</span><nav><a href="${siteUrl(locale, "/")}">ghfind.com</a><a href="/notifications">${escape(t.footer.emails)}</a><a href="/privacy">${escape(t.footer.privacy)}</a><a href="https://github.com/hikariming/ghfind">${escape(t.footer.source)}</a></nav></div></footer>
</body></html>`,
    { headers },
  );
}

/** A narrow single-column page: heading plus one card. */
const simple = (view: View, title: string, body: string, extra = "") =>
  html(
    view,
    title,
    `<div class="page"><h1>${escape(title)}</h1><div class="card">${body}</div>${extra}</div>`,
  );

// Runs in <head>: apply the saved theme before first paint, then wire the controls.
const CLIENT_SCRIPT = `(()=>{const d=document.documentElement,K='ghfind-bot-theme';let v='auto';try{v=localStorage.getItem(K)||v}catch{}
const apply=m=>{if(m==='light'||m==='dark')d.dataset.theme=m;else delete d.dataset.theme;document.querySelectorAll('[data-theme-choice]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.themeChoice===m)))};
apply(v);addEventListener('DOMContentLoaded',()=>{apply(v);document.querySelectorAll('[data-theme-choice]').forEach(b=>b.onclick=()=>{v=b.dataset.themeChoice;try{localStorage.setItem(K,v)}catch{}apply(v)});
const l=document.getElementById('lang');if(l)l.onchange=()=>{const u=new URL(location.href);u.searchParams.set('lang',l.value);location.href=u.toString()}})})()`;

function home(view: View, env: Env) {
  const { t, locale } = view;
  const h = t.home;
  const install =
    env.APP_SLUG && env.ENABLED === "true"
      ? `<a class="btn primary" href="https://github.com/apps/${encodeURIComponent(env.APP_SLUG)}/installations/new">${escape(h.install)}${ICONS.external}</a>`
      : `<span class="btn" aria-disabled="true">${escape(h.notOpen)}</span>`;
  const rollout =
    env.ALLOWED_ACCOUNTS && env.ALLOWED_ACCOUNTS !== "*"
      ? `<p class="note">${escape(format(h.rollout, { accounts: env.ALLOWED_ACCOUNTS }))}</p>`
      : "";
  const legend = LEGEND.map(
    ([id, name, color]) =>
      `<li><span class="label" style="background:${color}">${name}</span><strong dir="${id === "noScore" ? "auto" : "ltr"}">${escape(h.ranges[id])}</strong></li>`,
  ).join("");
  const steps = (["install", "open", "label"] as const)
    .map(
      (id, index) =>
        `<div class="card step"><span>${String(index + 1).padStart(2, "0")}</span><h3>${escape(h.steps[id].title)}</h3><p>${escape(h.steps[id].body)}</p></div>`,
    )
    .join("");
  return html(
    view,
    h.title,
    `<div class="hero"><div><span class="eyebrow">${escape(h.eyebrow)}</span><h1>${escape(h.title)}</h1><p class="lead">${escape(h.subtitle)}</p><div class="actions">${install}<a class="btn" href="${siteUrl(locale, "/github-bot")}">${escape(h.learnMore)}</a></div>${rollout}</div>
<div><div class="card legend"><h2>${escape(h.labelsHeading)}</h2><ul>${legend}</ul></div><p class="fine">${escape(h.labelsLead)} ${escape(h.labelsNote)}</p></div></div>
<section><h2>${escape(h.stepsHeading)}</h2><div class="grid">${steps}</div></section>
<section class="grid">
<div class="info"><h3>${escape(h.permissions.title)}</h3><p>${escape(h.permissions.body)}</p><a href="/privacy">${escape(t.footer.privacy)}</a></div>
<div class="info"><h3>${escape(h.emails.title)}</h3><p>${escape(h.emails.body)}</p><a href="/notifications">${escape(h.emails.link)}</a></div>
<div class="info"><h3>${escape(h.migrate.title)}</h3><p>${escape(h.migrate.body)}</p></div>
</section>`,
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
    return new Response(CLIENT_SCRIPT, {
      headers: {
        "Content-Type": "text/javascript",
        "Cache-Control": "public,max-age=3600",
      },
    });
  const locale = pickLocale(request, url);
  const view: View = {
    locale,
    t: MESSAGES[locale],
    setLocale: url.searchParams.get("lang") === locale,
  };
  const t = view.t;
  if (path === "/" && request.method === "GET") return home(view, env);
  if (path === "/privacy")
    return html(
      view,
      t.privacy.title,
      `<div class="page"><h1>${escape(t.privacy.title)}</h1><div class="card prose">${t.privacy.paragraphs.map((p) => `<p>${escape(p)}</p>`).join("")}</div></div>`,
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
      return simple(
        view,
        t.unsubscribe.doneTitle,
        `<p>${escape(t.unsubscribe.doneBody)}</p>`,
      );
    }
    if (request.method !== "GET")
      return new Response("Method not allowed", { status: 405 });
    return simple(
      view,
      t.unsubscribe.title,
      `<form method="post"><button class="btn primary">${escape(t.unsubscribe.button)}</button></form>`,
    );
  }
  if (path === "/notifications") {
    const n = t.notifications;
    if (env.EMAIL_ENABLED !== "true")
      return simple(view, n.disabledTitle, `<p>${escape(n.disabledBody)}</p>`);
    const current = await session(request, env);
    if (!current)
      return simple(
        view,
        n.title,
        `<p>${escape(n.body)}</p><p class="muted">${escape(n.authNote)}</p><a class="btn primary" href="/login?return_to=notifications">${escape(n.signIn)}</a>`,
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
        return simple(
          view,
          n.needAuthTitle,
          `<p>${escape(n.needAuthBody)}</p><a class="btn primary" href="/login?return_to=notifications">${escape(n.signInAgain)}</a>`,
        );
      }
      if (!email)
        return simple(view, n.noEmailTitle, `<p>${escape(n.noEmailBody)}</p>`);
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
    // Score emails exist in English and Chinese only; default to the reader's UI language.
    const emailLocale = sub?.locale ?? (locale === "zh" ? "zh" : "en");
    return simple(
      view,
      n.prefsTitle,
      `<p><strong>${escape(user.login)}</strong> <span class="status"${sub ? " data-on" : ""}>${escape(sub ? n.subscribed : n.notSubscribed)}</span></p><p class="muted">${escape(n.prefsBody)}</p><form method="post"><input type="hidden" name="csrf" value="${current.id}"><p><label class="field">${escape(n.emailLanguage)}<select name="locale"><option value="en">English</option><option value="zh"${emailLocale === "zh" ? " selected" : ""}>中文</option></select></label></p><p style="margin-top:14px"><label class="check"><input type="checkbox" name="consent" value="yes" required><span>${escape(n.consent)}</span></label></p><p style="margin-top:18px"><button class="btn primary">${escape(n.save)}</button></p></form>${sub ? `<p><a class="textlink" href="/notifications/unsubscribe?token=${sub.unsubscribe}">${escape(n.unsubscribe)}</a></p>` : ""}`,
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
    const s = t.setup;
    const installation = url.searchParams.get("installation_id");
    if (!installation || !/^\d{1,16}$/.test(installation))
      return simple(view, s.title, `<p>${escape(s.openFromGitHub)}</p>`);
    const current = await session(request, env);
    if (!current)
      return simple(
        view,
        s.receivedTitle,
        `<p>${escape(s.receivedBody)}</p><a class="btn primary" href="/login?installation_id=${installation}">${escape(s.signIn)}</a>`,
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
    const kind = (value: string) =>
      escape(s.kinds[value as keyof typeof s.kinds] ?? value);
    const state = (value: string) =>
      escape(s.states[value as keyof typeof s.states] ?? value);
    const rows = visible
      .map(
        (job) =>
          `<tr><td><a href="https://github.com/${escape(repos.get(job.repository!))}/labels">${escape(repos.get(job.repository!))}</a></td><td>${kind(job.kind)}${job.pr ? ` #${job.pr}` : ""}</td><td><span class="pill" data-state="${escape(job.state)}">${state(job.state)}</span>${job.result ? `<span class="result">${escape(job.result)}</span>` : ""}</td><td>${job.state === "failed" ? `<form method="post" action="/retry?installation_id=${installation}"><input type="hidden" name="csrf" value="${current.id}"><input type="hidden" name="id" value="${escape(job.id)}"><button class="btn">${escape(s.retry)}</button></form>` : ""}</td></tr>`,
      )
      .join("");
    return html(
      view,
      s.title,
      `<h1 style="font-size:clamp(26px,3.4vw,34px);letter-spacing:-.8px;font-weight:650">${escape(s.title)}</h1><p class="lead" style="margin-top:8px">${escape(s.refresh)}</p><div class="card table">${visible.length ? `<table><thead><tr><th>${escape(s.repository)}</th><th>${escape(s.task)}</th><th>${escape(s.status)}</th><th>${escape(s.action)}</th></tr></thead><tbody>${rows}</tbody></table>` : `<p class="empty">${escape(s.empty)}</p>`}</div>`,
    );
  }
  return new Response("Not found", { status: 404 });
}
async function readTextBounded(request: Request) {
  const { readText } = await import("./github");
  return readText(request, AbortSignal.timeout(5000), 4096);
}

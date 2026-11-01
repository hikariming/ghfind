import { ADMIN_STYLE } from "./admin-style";
import { ADMIN_SCRIPT } from "./admin-script";
import { ADMIN_MESSAGES, aiAuditLabel } from "./admin-i18n";
import { loadAdminData, parseAdminFilters } from "./admin-data";
import { loadGlobalAdminData, GLOBAL_ACCOUNT_PAGE_SIZE, type GlobalRepositoryScope } from "./admin-global-data";
import { JOINED_JOB_ITEM_ORDER_SQL, compareJobsByItem } from "./job-display-order";
import { adminShell, adminLink, pageHead, installationPage, dashboardPage, globalDashboardPage, repositoriesPage, tasksPage, activityPage, type AdminContext } from "./admin-ui";
import { runIntentPreview, IntentPreviewError, type IntentPreviewResult } from "./intent-preview";
import { getAIProvider, putAIProvider, removeAIProviderKey, resolveAIEnv, AIProviderError } from "./byok";
import { testAIProvider } from "./provider-test";
import { seal, unseal } from "./secrets";
import { audit, recentAudit } from "./audit";
import {
  cancelCleanup,
  Cleanup,
  confirmCleanup,
  createCleanup,
  latestCleanup,
  parseScopeForm,
} from "./cleanup";
import { repoLabels } from "./repo-labels";
import { verifiedEmail } from "./author-email";
import { ApiError, github, jsonRequest, record, positive } from "./github";
import {
  dispatch,
  Job,
  lastBackfill,
  putBackfill,
  retryJob,
} from "./jobs";
import {
  getSettings,
  llmConfigured,
  triageConfigured,
  parseBackfillLimit,
  parseSettingsForm,
  putBackfillLimit,
  putSettings,
} from "./settings";
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
.btn:disabled{cursor:not-allowed;opacity:.55;transform:none}
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
/* Theme-coloured scrollbars for inner scroll areas. */
.table,.labels{scrollbar-color:var(--border) transparent}
table{width:100%;border-collapse:collapse;font-size:13px}
th{padding:12px 16px;text-align:start;font-size:11px;font-weight:600;letter-spacing:.3px;text-transform:uppercase;color:var(--muted);background:var(--surface);border-bottom:1px solid var(--border)}
td{padding:12px 16px;border-bottom:1px solid var(--border);vertical-align:middle}
tr:last-child td{border-bottom:0}
td a{color:var(--link)}
td{overflow-wrap:anywhere}
.table table{min-width:580px;table-layout:fixed}
.table th:first-child{width:35%}
.pill{display:inline-block;padding:2px 9px;border-radius:999px;background:var(--muted-bg);font-size:11px;font-weight:600}
.pill[data-state=done]{background:var(--accent-bg);color:var(--accent)}
.pill[data-state=failed]{background:#fbeaea;color:#a33a3a}
:root[data-theme=dark] .pill[data-state=failed]{background:#3a2020;color:#f0a4a4}
@media(prefers-color-scheme:dark){:root:not([data-theme=light]) .pill[data-state=failed]{background:#3a2020;color:#f0a4a4}}
.result{display:block;margin-top:4px;font-size:12px;color:var(--muted)}
.table .btn{padding:6px 12px;font-size:12px}
.empty{padding:28px;text-align:center;color:var(--muted);font-size:13px}
fieldset{min-width:0;margin:0;padding:0;border:0}
legend{padding:0}
.page h1{overflow-wrap:anywhere}
.page .card.list{padding:0}
.rows{margin:0;padding:0;list-style:none}
.rows li+li{border-top:1px solid var(--border)}
.rows a{display:flex;justify-content:space-between;gap:12px;padding:14px 20px;color:var(--link);font-weight:500;overflow-wrap:anywhere}
.rows a:hover{background:var(--surface)}
.rows a .muted{flex:none;white-space:nowrap}
.crumbs{display:flex;flex-wrap:wrap;gap:6px 16px;margin-bottom:12px;font-size:12px}
.notice{padding:12px 14px;border-inline-start:3px solid var(--accent);border-radius:10px;background:var(--surface);font-size:13px;line-height:1.7}
.stack>*+*{margin-top:22px}
.stack h2{font-size:15px}
.stack .check+.check{margin-top:6px}
.field strong{color:var(--fg);font-size:13px;font-weight:600}
input[type=number],textarea{font:inherit;font-size:13px;color:var(--fg);background:var(--card);border:1px solid var(--border);border-radius:8px;padding:8px 10px}
input[type=number]{width:120px}
textarea{width:100%;min-height:120px;resize:vertical}
input:disabled,textarea:disabled{cursor:not-allowed;opacity:.6}
.labels{max-height:480px;margin:10px 0 0;padding:0;list-style:none;overflow:auto;border:1px solid var(--border);border-radius:12px}
.labels li{padding:10px 14px}
.labels li+li{border-top:1px solid var(--border)}
.swatch{flex:none;width:12px;height:12px;margin-top:6px;border:1px solid var(--border);border-radius:999px;background:var(--muted-bg)}
.grow{min-width:0;overflow-wrap:anywhere}
.log{margin:0;padding:0;list-style:none}
.log li{display:grid;gap:3px;padding:11px 0;border-top:1px solid var(--border)}
.log li:last-child{padding-bottom:0}
.log .what{min-width:0;font-size:13px;overflow-wrap:anywhere}
.log .what .muted{font-size:12px}
.log .who{display:flex;flex-wrap:wrap;align-items:center;gap:4px 8px;font-size:12px;color:var(--muted);overflow-wrap:anywhere}
.log time{font-variant-numeric:tabular-nums;white-space:nowrap}
footer{border-top:1px solid var(--border);background:var(--surface)}
footer .wrap{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:12px;padding-top:22px;padding-bottom:22px;font-size:12px;color:var(--muted)}
footer nav{display:flex;flex-wrap:wrap;gap:18px}
.session-signout{border:0;padding:0;background:none;color:inherit;font:inherit;cursor:pointer}
.session-signout:hover{color:var(--fg)}
footer a:hover{color:var(--fg)}
:focus-visible{outline:2px solid var(--link);outline-offset:3px;border-radius:6px}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
@media(max-width:860px){.hero{grid-template-columns:1fr;gap:32px}.grid{grid-template-columns:1fr}}
@media(max-width:640px){.wrap{padding:0 16px}main.wrap{padding-top:28px}.navlink{display:none}.tools select{max-width:104px}.top .wrap{gap:10px}.hero h1{font-size:30px;letter-spacing:-1px}.page .card{padding:20px}th,td{padding:10px 12px}}
@media(max-width:360px){.top .wrap{flex-wrap:wrap;padding-top:10px;padding-bottom:10px}.tools{width:100%;justify-content:space-between}}
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

type View = { locale: Locale; t: Messages; setLocale: boolean; session?: string; admin?: AdminContext };

// Public scripts are cached, while HTML is not. Derive cache revisions from
// their contents so a rebuilt UI never silently reuses the previous behavior.
function scriptRevision(source: string) {
  let value = 2166136261;
  for (let index = 0; index < source.length; index++)
    value = Math.imul(value ^ source.charCodeAt(index), 16777619);
  return (value >>> 0).toString(36);
}
const adminScriptUrl = `/admin.js?v=${scriptRevision(ADMIN_SCRIPT)}`;
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
    `<!doctype html><html lang="${locale}" dir="${locale === "ar" ? "rtl" : "ltr"}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)} · ghfind Review</title><link rel="icon" href="/avatar.png"><style>${STYLE}${view.admin ? ADMIN_STYLE : ""}</style><script src="${themeScriptUrl}"></script>${view.admin ? `<script src="${adminScriptUrl}" defer></script>` : ""}</head><body>${view.admin ? adminShell(view.admin,t,content,`<label><span class="sr">${escape(t.nav.language)}</span><select id="lang">${languages}</select></label><div class="theme" role="group" aria-label="${escape(t.nav.theme)}">${theme}</div>`,view.session) : `
<header class="top"><div class="wrap"><a class="brand" href="/"><img src="/avatar.png" width="28" height="28" alt="">ghfind Review</a><div class="tools"><a class="navlink" href="${siteUrl(locale, "/github-bot")}">${escape(t.nav.site)}${ICONS.external}</a><label><span class="sr">${escape(t.nav.language)}</span><select id="lang">${languages}</select></label><div class="theme" role="group" aria-label="${escape(t.nav.theme)}">${theme}</div></div></div></header>
<main class="wrap">${content}</main>
<footer><div class="wrap"><span>© ghfind</span><nav><a href="${siteUrl(locale, "/")}">ghfind.com</a><a href="/notifications">${escape(t.footer.emails)}</a><a href="/privacy">${escape(t.footer.privacy)}</a><a href="https://github.com/hikariming/ghfind">${escape(t.footer.source)}</a>${view.session ? `<form method="post" action="/logout"><input type="hidden" name="csrf" value="${view.session}"><button class="session-signout">${escape(t.admin.signOut)}</button></form>` : ""}</nav></div></footer>
`}</body></html>`,
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
const themeScriptUrl = `/theme.js?v=${scriptRevision(CLIENT_SCRIPT)}`;

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
    `<div class="hero"><div><span class="eyebrow">${escape(h.eyebrow)}</span><h1>${escape(h.title)}</h1><p class="lead">${escape(h.subtitle)}</p><div class="actions">${install}<a class="btn" href="/admin">${escape(t.admin.title)}</a><a class="btn" href="${siteUrl(locale, "/github-bot")}">${escape(h.learnMore)}</a></div>${rollout}</div>
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
const withStatus = (response: Response, status: number) =>
  new Response(response.body, { status, headers: response.headers });
type Api = ReturnType<typeof github>;
// The user-token endpoint intersects App installation scope with the user's
// current access. The query parameter alone never grants access.
async function accessibleRepos(api: Api, installation: string) {
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
  return repos;
}
async function userInstallations(api: Api) {
  const found: { id: number; account: string }[] = [];
  for (let page = 1; page <= 10; page++) {
    const list = record(
      await api(`/user/installations?per_page=100&page=${page}`),
    );
    if (!Array.isArray(list.installations))
      throw new Error("Invalid installations");
    for (const item of list.installations) {
      const x = record(item);
      const login =
        x.account && typeof x.account === "object"
          ? (x.account as Record<string, unknown>).login
          : undefined;
      if (typeof x.id === "number" && Number.isSafeInteger(x.id) && x.id > 0)
        found.push({
          id: x.id,
          account: typeof login === "string" ? login : `#${x.id}`,
        });
    }
    if (list.installations.length < 100) break;
  }
  return found;
}
/** One bounded user-token listing per account, followed by the same live repo
 * permission checks used by the scoped pages. Never enumerate 100 API pages
 * just to render a global dashboard request. */
async function globalRepositoryScope(api: Api, installation: number, repoPage: number): Promise<GlobalRepositoryScope> {
  const offset = (repoPage - 1) * 25;
  const upstreamPage = Math.floor(offset / 100) + 1;
  const list = record(await api(`/user/installations/${installation}/repositories?per_page=100&page=${upstreamPage}`));
  if (!Array.isArray(list.repositories) || list.repositories.length > 100) throw new Error("Invalid repositories");
  const fullPage = list.repositories.map(item => {
    const repo = record(item);
    if (typeof repo.full_name !== "string") throw new Error("Invalid repository");
    return [positive(repo.id), repo.full_name] as const;
  });
  const countKnown = typeof list.total_count === "number" && Number.isSafeInteger(list.total_count) && list.total_count >= 0;
  const totalAccessible = countKnown ? list.total_count as number : (upstreamPage - 1) * 100 + fullPage.length;
  if (countKnown && fullPage.length > 0 && totalAccessible < (upstreamPage - 1) * 100 + fullPage.length) throw new Error("Invalid repository count");
  const repositories = new Map(fullPage.slice(offset % 100, offset % 100 + 25));
  return { repositories, totalAccessible, hasNext: repoPage < 400 && (offset + 25 < totalAccessible || !countKnown && fullPage.length === 100), partial: !countKnown && (fullPage.length === 100 || upstreamPage > 1) };
}
/** Live check with the user's token, like Retry; never cached. */
async function repoPermissions(api: Api, fullName: string, repositoryId: number) {
  const repo = record(await api(`/repos/${fullName}`));
  // GitHub may redirect a name after a transfer. A stale installation listing
  // must not authorize the new owner's repository or inherit old preferences.
  const owner = (name: string) => name.split("/")[0].toLowerCase();
  if (repo.id !== repositoryId || typeof repo.full_name !== "string" || owner(repo.full_name) !== owner(fullName))
    return { admin: false, write: false };
  const permissions = record(repo.permissions);
  return { admin: permissions.admin === true, write: permissions.admin === true || permissions.push === true };
}
async function repoAdmin(api: Api, fullName: string, repositoryId: number) {
  return (await repoPermissions(api, fullName, repositoryId)).admin;
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
const utc = (ms: number) =>
  new Date(ms).toISOString().slice(0, 16).replace("T", " ");
// Danger zone: preview, then confirm. The same backend serves the CLI.
function cleanupCard(
  a: Messages["admin"],
  query: string,
  csrf: string,
  admin: boolean,
  cleanup: Cleanup | null,
  viewer: string | null,
) {
  const active = !!cleanup && (cleanup.state === "planning" || cleanup.state === "running" || (cleanup.state === "planned" && cleanup.expires > Date.now()));
  const scope = active ? JSON.parse(cleanup!.scope) as { labels?: string; comments?: boolean; definitions?: boolean } : null;
  const checked = (name: string) => name === "review_labels" ? scope?.labels === "review" || scope?.labels === "all" : name === "triage_labels" ? scope?.labels === "triage" || scope?.labels === "all" : name === "comments" ? scope?.comments : scope?.definitions;
  const box = (name: string, text: string) =>
    `<label class="check"><input type="checkbox" name="${name}" value="on"${checked(name) ? " checked" : ""}${active ? " disabled" : ""}><span>${escape(text)}</span></label>`;
  const action = (path: string, label: string, primary = false) =>
    cleanup
      ? `<form method="post" action="/admin/cleanup/${path}?${escape(query)}"><input type="hidden" name="csrf" value="${csrf}"><input type="hidden" name="cleanup" value="${escape(cleanup.id)}"><button class="btn${primary ? " primary" : ""}">${escape(label)}</button></form>`
      : "";
  const busy = active;
  let state = "";
  if (cleanup) {
    const name =
      cleanup.state === "planned" && cleanup.expires <= Date.now()
        ? "expired"
        : (cleanup.state as keyof typeof a.cleanStates);
    const summary = JSON.parse(cleanup.summary) as Record<string, number | boolean>;
    const detail =
      name === "planning"
        ? a.cleanPlanning
        : name === "planned"
          ? format(a.cleanPlanned, {
              review: String(summary.review_labels),
              triage: String(summary.triage_labels),
              comments: String(summary.comments),
              definitions: String(summary.label_definitions),
              time: utc(cleanup.expires),
            })
          : name === "running" || name === "done" || name === "failed" || name === "cancelled"
            ? format(a.cleanProgress, {
                done: String(cleanup.done),
                skipped: String(cleanup.skipped),
                total: String(cleanup.total),
              })
            : name === "expired" ? a.cleanExpired : (cleanup.result ?? "");
    const notes = [
      name === "planned" && summary.truncated ? a.cleanTruncated : "",
      name === "planned" && summary.bot_active ? a.cleanBotActive : "",
      name === "running" || name === "cancelled" ? a.cleanCancelHint : "",
      ["planning", "running", "done", "failed", "cancelled"].includes(name) && cleanup.result ? cleanup.result : "",
    ]
      .filter(Boolean)
      .map((x) => `<p class="notice">${escape(x)}</p>`)
      .join("");
    const controls = !admin
      ? ""
      : name === "planned"
        ? cleanup.requested_by === viewer
          ? `<div class="actions" style="margin-top:12px">${action("confirm", a.cleanConfirm, true)}${action("cancel", a.cleanCancel)}</div>`
          : `<p class="result">${escape(format(a.cleanOwner, { login: cleanup.requested_by }))}</p><div class="actions" style="margin-top:12px">${action("cancel", a.cleanCancel)}</div>`
        : name === "planning" || name === "running"
          ? `<div class="actions" style="margin-top:12px"><a class="btn" href="/admin/repo?${escape(query)}&amp;tab=cleanup#cleanup">${escape(a.cleanRefresh)}</a>${action("cancel", a.cleanCancel)}</div>`
          : "";
    state = `<p class="result">${escape(a.cleanLast)} <span class="state-text" data-state="${escape(name)}">${escape(a.cleanStates[name] ?? name)}</span> <time datetime="${new Date(cleanup.updated).toISOString()}">${utc(cleanup.updated)} UTC</time></p>${detail ? `<p>${escape(detail)}</p>` : ""}${notes}${controls}`;
  } else state = `<p class="result">${escape(a.cleanLast)} ${escape(a.cleanNever)}</p>`;
  return `<div class="operation-main" id="cleanup"><form method="post" action="/admin/cleanup?${escape(query)}"><input type="hidden" name="csrf" value="${csrf}"><fieldset class="stack"${admin ? "" : " disabled"}><div><h2>${escape(a.cleanup)}</h2><p class="result">${escape(a.cleanupHint)}</p>
<p style="margin-top:10px">${box("review_labels", a.cleanReview)}${box("triage_labels", a.cleanTriage)}${box("comments", a.cleanComments)}${box("delete_label_definitions", a.cleanDefinitions)}</p></div>
${admin ? `<p><button class="btn"${busy ? " disabled" : ""}>${escape(a.cleanPlan)}</button></p>` : ""}<p class="result">${escape(a.cleanCli)}</p></fieldset></form><div class="stack" style="margin-top:14px">${state}</div></div>`;
}
// Recent settings changes and operations (web and API). Only counts and ids are
// shown from the stored detail, never the raw JSON.
type AuditEntry = Awaited<ReturnType<typeof recentAudit>>[number];
function activityDetail(a: Messages["admin"], x: AuditEntry) {
  const d = (x.detail && typeof x.detail === "object" ? x.detail : {}) as Record<string, unknown>;
  const count = (v: unknown) =>
    typeof v === "number" && Number.isFinite(v) ? String(v) : null;
  switch (x.action) {
    case "backfill":
      return count(d.limit) && format(a.activityLimit, { count: count(d.limit)! });
    case "retry":
      return count(d.retried) && format(a.activityRetried, { count: count(d.retried)! });
    case "pause": {
      const n = count(d.cancelled_jobs ?? d.cancelled);
      return n && n !== "0" ? format(a.activityCancelled, { count: n }) : null;
    }
    case "settings.update":
      return Array.isArray(d.changed) && d.changed.length
        ? format(a.activityChanged, {
            fields:
              d.changed.slice(0, 6).map((k) => String(k).slice(0, 40)).join(", ") +
              (d.changed.length > 6 ? ", …" : ""),
          })
        : null;
    default:
      return x.action.startsWith("cleanup.") && typeof d.id === "string"
        ? `#${d.id.slice(0, 8)}`
        : null;
  }
}
function activityCard(a: Messages["admin"], log: AuditEntry[], locale: Locale) {
  const items = log
    .map((x) => {
      const label = aiAuditLabel(locale, x.action) ?? a.activityActions[x.action as keyof typeof a.activityActions] ?? x.action;
      const detail = activityDetail(a, x);
      const via = a.activityVia[x.via as keyof typeof a.activityVia] ?? x.via;
      return `<li><span class="what"><strong>${escape(label)}</strong>${detail ? ` <span class="muted">· <bdi>${escape(detail)}</bdi></span>` : ""}</span><span class="who"><time dir="ltr" datetime="${escape(x.at)}">${escape(utc(Date.parse(x.at)))} UTC</time><bdi>${escape(x.actor)}</bdi><span class="state-text">${escape(via)}</span></span></li>`;
    })
    .join("");
  return `<div class="operation-main" id="activity"><div><h2 style="font-size:15px">${escape(a.activity)}</h2><p class="result">${escape(a.activityHint)}</p></div>${items ? `<ul class="log">${items}</ul>` : `<p class="result">${escape(a.activityEmpty)}</p>`}</div>`;
}
export async function ui(request: Request, env: Env): Promise<Response> {
  try {
    return await renderUi(request, env);
  } catch (error) {
    if (!(error instanceof ApiError) || error.status !== 401) throw error;
    const url = new URL(request.url);
    const locale = pickLocale(request, url);
    const t = MESSAGES[locale];
    const returnTo = url.pathname.startsWith("/notifications") ? "notifications" : "admin";
    const response = simple(
      { locale, t, setLocale: false, ...(returnTo === "admin" ? { admin: { path: "/admin", locale, lang: url.searchParams.get("lang") === locale ? locale : undefined } } : {}) },
      returnTo === "notifications" ? t.notifications.title : t.admin.title,
      `<p>${escape(returnTo === "notifications" ? t.notifications.body : t.admin.signInBody)}</p><a class="btn primary" href="/login?return_to=${returnTo}">${escape(t.admin.signIn)}</a>`,
    );
    response.headers.set("Set-Cookie", cookieHeader("ghfind_bot_session", "", 0));
    return withStatus(response, 401);
  }
}
async function renderUi(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url),
    path = url.pathname;
  if (path === "/theme.js" || path === "/admin.js")
    return new Response(path === "/theme.js" ? CLIENT_SCRIPT : ADMIN_SCRIPT, {
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
  if (path === "/logout") {
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
    if (request.headers.get("origin") !== url.origin) return new Response("Invalid origin", { status: 403 });
    const current = await session(request, env);
    if (!current) return redirect("/admin", cookieHeader("ghfind_bot_session", "", 0));
    const form = new URLSearchParams(await readTextBounded(request));
    if (form.get("csrf") !== current.id) return new Response("Invalid form", { status: 403 });
    await env.DB.prepare("DELETE FROM sessions WHERE id=?").bind(`session:${current.id}`).run();
    return redirect("/admin", cookieHeader("ghfind_bot_session", "", 0));
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
    view.session = current.id;
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
    // The one-use state row stores only a fixed page name or a numeric installation.
    const returnTo = url.searchParams.get("return_to");
    const installation =
      returnTo === "notifications" || returnTo === "admin"
        ? returnTo
        : url.searchParams.get("installation_id");
    if (
      !installation ||
      (installation !== "notifications" &&
        installation !== "admin" &&
        !/^\d{1,16}$/.test(installation)) ||
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
        : row.value === "admin"
          ? "/admin"
          : `/setup?installation_id=${row.value}`,
      cookieHeader("ghfind_bot_session", id, 3600),
    );
  }
  if (
    path === "/admin" ||
    path === "/admin/installations" ||
    path === "/admin/repositories" ||
    path === "/admin/tasks" ||
    path === "/admin/activity" ||
    path === "/admin/toggle" ||
    path === "/admin/ai-provider" ||
    path === "/admin/ai-provider/test" ||
    path === "/admin/ai-provider/remove" ||
    path === "/admin/intent-preview" ||
    path === "/admin/repo" ||
    path === "/admin/backfill" ||
    path.startsWith("/admin/cleanup")
  ) {
    const a = t.admin;
    const dashboard = ["/admin", "/admin/installations", "/admin/repositories", "/admin/tasks", "/admin/activity"].includes(path);
    view.admin = { path, locale, lang: url.searchParams.get("lang") === locale ? locale : undefined };
    const current = await session(request, env);
    if (!current) {
      if (request.method !== "GET")
        return new Response("Sign in required", { status: 403 });
      return simple(
        view,
        a.title,
        `<p>${escape(a.signInBody)}</p><a class="btn primary" href="/login?return_to=admin">${escape(a.signIn)}</a>`,
      );
    }
    let form: URLSearchParams | undefined;
    if (request.method === "POST" && !dashboard) {
      if (request.headers.get("origin") !== url.origin)
        return new Response("Invalid origin", { status: 403 });
      // Worst case within parseSettingsForm's limits: 50 labels x 100 UTF-16
      // units at 9 bytes each once percent-encoded (~46 KB) plus a 2000-unit
      // prompt (~18 KB). Anything larger would be rejected anyway.
      try {
        // A preview permits 8,000 UTF-16 units of text: CJK form encoding
        // can take 9 bytes per unit, plus title and CSRF overhead.
        form = new URLSearchParams(await readTextBounded(request, path === "/admin/intent-preview" ? 80 * 1024 : 65536));
      } catch {
        form = undefined;
      }
      if (form && form.get("csrf") !== current.id)
        return new Response("Invalid form", { status: 403 });
    } else if (
      request.method !== "GET" ||
      path === "/admin/backfill" ||
      path === "/admin/toggle" ||
      path === "/admin/ai-provider" ||
      path === "/admin/ai-provider/test" ||
      path === "/admin/ai-provider/remove" ||
      path === "/admin/intent-preview" ||
      path.startsWith("/admin/cleanup")
    )
      return new Response("Method not allowed", { status: 405 });
    view.session = current.id;
    const globalDashboard = path === "/admin" && !url.searchParams.has("installation_id");
    const accountPages = url.searchParams.getAll("account_page");
    if (globalDashboard && (accountPages.length > 1 || (accountPages[0] !== undefined && (!/^[1-9]\d{0,2}$/.test(accountPages[0]) || Number(accountPages[0]) > 250))))
      return new Response("Invalid account page", { status: 400 });
    const api = github(current.token, dashboard ? Date.now() + (globalDashboard ? 30_000 : 15_000) : undefined);
    let installation = url.searchParams.get("installation_id");
    if (installation !== null && !/^\d{1,16}$/.test(installation))
      return new Response("Invalid installation", { status: 400 });
    if (installation === null && !dashboard)
      return new Response("Invalid installation", { status: 400 });
    const installs = await userInstallations(api);
    view.admin.installations = installs;
    const selected = installation === null
      ? installs[0]
      : installs.find(item => String(item.id) === installation);
    if (installation !== null && !selected)
      return new Response("Not found", { status: 404 });
    // Installation management is a page within the selected workspace, not a
    // reset of its context. Direct entry can still offer every available account.
    view.admin.installation = selected ? String(selected.id) : undefined;
    view.admin.account = selected?.account;
    try {
      view.admin.repoPage = parseAdminFilters(url.searchParams).repoPage;
      const listPage = path === "/admin/repositories";
      const q = (url.searchParams.get(listPage ? "q" : "return_q") ?? "").trim();
      const processing = url.searchParams.get(listPage ? "processing" : "return_processing") ?? "";
      if (q.length > 100 || /[\x00-\x1f\x7f]/.test(q) || !["", "active", "paused"].includes(processing))
        throw new Error("Invalid repository context");
      if (url.searchParams.getAll("return_q").length > 1 || url.searchParams.getAll("return_processing").length > 1)
        throw new Error("Invalid repository context");
      view.admin.repositoryQuery = { q, processing };
    } catch {
      return new Response("Invalid filters", { status: 400 });
    }
    if (globalDashboard) {
      if (Number(accountPages[0] ?? 1) > Math.max(1, Math.ceil(installs.length / GLOBAL_ACCOUNT_PAGE_SIZE)))
        return new Response("Invalid account page", { status: 400 });
      view.admin.global = true;
      const data = await loadGlobalAdminData(env, api, installs, (id, page) => globalRepositoryScope(api, id, page), url.searchParams);
      return html(view, ADMIN_MESSAGES[locale].overview, globalDashboardPage(view.admin, t, data, current.id,
        env.APP_SLUG && env.ENABLED === "true" ? `https://github.com/apps/${encodeURIComponent(env.APP_SLUG)}/installations/new` : undefined));
    }
    if (dashboard && (installation === null || path === "/admin/installations")) {
      view.admin.path = "/admin/installations";
      return html(view, ADMIN_MESSAGES[locale].installations, installationPage(view.admin,t,
        env.APP_SLUG && env.ENABLED === "true" ? `https://github.com/apps/${encodeURIComponent(env.APP_SLUG)}/installations/new` : undefined));
    }
    installation = view.admin.installation ?? null;
    if (!installation || !/^\d{1,16}$/.test(installation))
      return new Response("Invalid installation", { status: 400 });
    let repos: Map<number, string>;
    try {
      repos = await accessibleRepos(api, installation);
    } catch (error) {
      if (error instanceof ApiError && [403, 404].includes(error.status))
        return new Response("Not found", { status: 404 });
      throw error;
    }
    view.admin.installation = installation;
    // The installation account remains usable even when it has no repositories.
    view.admin.account = selected?.account ?? [...repos.values()][0]?.split("/")[0];
    if (dashboard) {
      try { parseAdminFilters(url.searchParams); }
      catch { return new Response("Invalid filters", { status: 400 }); }
      if (path === "/admin/repositories" && !["", "active", "paused"].includes(url.searchParams.get("processing") ?? ""))
        return new Response("Invalid filters", { status: 400 });
      let data: Awaited<ReturnType<typeof loadAdminData>>;
      try { data = await loadAdminData(env, api, Number(installation), repos, url.searchParams); }
      catch(error) {
        if (error instanceof ApiError && error.status === 404 && !error.retry) return new Response("Not found", { status: 404 });
        throw error;
      }
      view.admin.repoPage = data.scope.page;
      const render = path === "/admin/repositories" ? repositoriesPage(view.admin,t,data,current.id,url)
        : path === "/admin/tasks" ? tasksPage(view.admin,t,data,current.id,url)
        : path === "/admin/activity" ? activityPage(view.admin,t,data,url)
        : dashboardPage(view.admin,t,data,current.id);
      const title = path === "/admin/repositories" ? ADMIN_MESSAGES[locale].repositories : path === "/admin/tasks" ? ADMIN_MESSAGES[locale].tasks : path === "/admin/activity" ? ADMIN_MESSAGES[locale].activity : ADMIN_MESSAGES[locale].overview;
      return html(view,title,render);
    }
    const repository = url.searchParams.get("repository");
    const fullName = repository && /^\d{1,16}$/.test(repository)
      ? repos.get(Number(repository))
      : undefined;
    if (!fullName) return new Response("Not found", { status: 404 });
    const target = adminLink(view.admin, "/admin/repo", { repository: Number(repository) });
    const query = new URL(target, url).searchParams.toString();
    const operationTab = path === "/admin/backfill" ? "backfill"
      : path.startsWith("/admin/cleanup") ? "cleanup"
      : path === "/admin/intent-preview" ? "preview"
      : path.startsWith("/admin/ai-provider") ? "ai" : "settings";
    const backTarget = operationTab === "settings" ? target : `${target}&tab=${operationTab}`;
    const invalid = (title = a.invalidTitle, body = a.invalidBody, status = 400) =>
      withStatus(
        simple(
          view,
          title,
          `<p>${escape(body)}</p><a class="btn" href="${escape(backTarget)}">${escape(a.back)}</a>`,
        ),
        status,
      );
    const login = async () => {
      const user = record(await api("/user"));
      return typeof user.login === "string" && /^[A-Za-z0-9-]+$/.test(user.login)
        ? user.login
        : null;
    };
    const aiAction = ["/admin/ai-provider", "/admin/ai-provider/test", "/admin/ai-provider/remove"].includes(path);
    let aiError: AIProviderError["code"] | undefined;
    let aiStatus = 200;
    let aiPermissions: Awaited<ReturnType<typeof repoPermissions>> | undefined;
    if (request.method === "POST" && aiAction) {
      aiPermissions = await repoPermissions(api, fullName, Number(repository));
      if (!aiPermissions.admin) return new Response("Repository admin required", { status: 403 });
      if (!form || ["mode", "provider", "base_url", "model", "api_key", "confirm_remove"].some(key => form!.getAll(key).length > 1)) return invalid();
      if (path === "/admin/ai-provider/remove" && form.get("confirm_remove") !== "yes") return invalid();
      try {
        let result = "saved";
        if (path === "/admin/ai-provider/test") {
          const user = await login();
          if (!user) return new Response("Invalid user", { status: 400 });
          // Connection tests always use saved configuration, never the form's key.
          const tested = await testAIProvider(env, Number(repository), fullName);
          await audit(env, Number(repository), user, "web", "ai_provider.test", { provider: tested.provider, model: tested.model });
          result = "tested";
        } else {
          const user = await login();
          if (!user) return new Response("Invalid user", { status: 400 });
          if (path === "/admin/ai-provider/remove") {
            await removeAIProviderKey(env, Number(repository), fullName, user);
            result = "removed";
          } else {
            const input: Record<string, unknown> = { mode: form.get("mode") };
            if (input.mode !== "platform") {
              for (const key of ["provider", "base_url", "model"]) input[key] = form.get(key);
              const key = form.get("api_key");
              if (key) input.api_key = key;
            }
            await putAIProvider(env, Number(repository), fullName, input, user);
          }
        }
        return redirect(`${target}&tab=ai&ai=${result}`);
      } catch (error) {
        if (!(error instanceof AIProviderError)) throw error;
        aiError = error.code; aiStatus = error.status;
        // Never retain a submitted key or credential form values in the response.
        form = undefined;
      }
    }
    if (request.method === "POST" && path === "/admin/toggle") {
      if (!(await repoAdmin(api, fullName, Number(repository)))) return new Response("Repository admin required", { status: 403 });
      if (!form || !["on", "off"].includes(form.get("enabled") ?? "")) return invalid();
      const user = await login();
      if (!user) return new Response("Invalid user", { status: 400 });
      const previous = await getSettings(env, Number(repository), fullName);
      const { backfillLimit: _limit, ...value } = previous;
      const enabled = form.get("enabled") === "on";
      value.issuesEnabled = enabled; value.prsEnabled = enabled;
      await putSettings(env, Number(installation), Number(repository), fullName, value, user);
      await audit(env, Number(repository), user, "web", "settings.update", { changed: ["issuesEnabled", "prsEnabled"] });
      return redirect(adminLink(view.admin, "/admin/repositories"));
    }
    let previewResult: IntentPreviewResult | undefined;
    let previewError: IntentPreviewError["code"] | undefined;
    let previewStatus = 200;
    let previewPermissions: Awaited<ReturnType<typeof repoPermissions>> | undefined;
    if (request.method === "POST" && path === "/admin/intent-preview") {
      previewPermissions = await repoPermissions(api, fullName, Number(repository));
      if (!previewPermissions.admin) return new Response("Repository admin required", { status: 403 });
      if (!form) return invalid();
      try { previewResult = await runIntentPreview(env,api,Number(repository),fullName,form); }
      catch(error) {
        if (!(error instanceof IntentPreviewError)) throw error;
        previewError = error.code; previewStatus = error.status;
      }
    }
    if (request.method === "POST" && path === "/admin/backfill") {
      if (!(await repoAdmin(api, fullName, Number(repository))))
        return new Response("Repository admin required", { status: 403 });
      let limit: number;
      try {
        if (!form) throw new Error("Invalid settings");
        limit = parseBackfillLimit(form);
      } catch {
        return invalid(a.backfillInvalidTitle, a.backfillInvalid);
      }
      const busy = () => invalid(a.backfillBusyTitle, a.backfillBusy, 409);
      const last = await lastBackfill(env, Number(repository));
      if (last && (last.state === "pending" || last.state === "running"))
        return busy();
      const user = await login();
      if (!user) return new Response("Invalid user", { status: 400 });
      await putBackfillLimit(
        env,
        Number(installation),
        Number(repository),
        fullName,
        limit,
        user,
      );
      if (!(await putBackfill(env, Number(installation), Number(repository), fullName)))
        return busy();
      await audit(env, Number(repository), user, "web", "backfill", { limit });
      await dispatch(env);
      return redirect(`${target}&tab=backfill&backfill=queued`);
    }
    if (request.method === "POST" && path.startsWith("/admin/cleanup")) {
      if (!(await repoAdmin(api, fullName, Number(repository))))
        return new Response("Repository admin required", { status: 403 });
      if (!form) return invalid();
      const user = await login();
      if (!user) return new Response("Invalid user", { status: 400 });
      const done = () => redirect(`${target}&tab=cleanup#cleanup`);
      if (path === "/admin/cleanup") {
        let scope;
        try {
          scope = parseScopeForm(form);
        } catch {
          return invalid(a.cleanInvalidTitle, a.cleanInvalid);
        }
        const settings = await getSettings(env, Number(repository), fullName);
        const created = await createCleanup(
          env,
          Number(installation),
          Number(repository),
          fullName,
          scope,
          user,
          settings.issuesEnabled || settings.prsEnabled,
        );
        if (!created) return invalid(a.cleanBusyTitle, a.cleanBusy, 409);
        await audit(env, Number(repository), user, "web", "cleanup.plan", {
          id: created.cleanup.id,
        });
        await env.JOBS.send({ cleanup: created.cleanup.id });
        return done();
      }
      const id = form.get("cleanup") ?? "";
      if (!/^[0-9a-f-]{36}$/.test(id)) return invalid();
      if (path === "/admin/cleanup/confirm") {
        if (
          (await confirmCleanup(
            env,
            Number(repository),
            { id, requester: user },
            user,
          )) === "ok"
        ) {
          await audit(env, Number(repository), user, "web", "cleanup.confirm", { id });
          await env.JOBS.send({ cleanup: id });
        }
        return done();
      }
      if (path === "/admin/cleanup/cancel") {
        if (await cancelCleanup(env, Number(repository), id))
          await audit(env, Number(repository), user, "web", "cleanup.cancel", { id });
        return done();
      }
      return new Response("Not found", { status: 404 });
    }
    if (request.method === "POST" && path !== "/admin/intent-preview" && !aiAction) {
      if (!(await repoAdmin(api, fullName, Number(repository))))
        return new Response("Repository admin required", { status: 403 });
      if (!form) return invalid();
      let value;
      try {
        value = parseSettingsForm(form);
      } catch {
        return invalid();
      }
      const user = await login();
      if (!user) return new Response("Invalid user", { status: 400 });
      const availableLabels = new Set((await repoLabels(api, fullName)).map((x) => x.name));
      if (value.allowedLabels.some((name) => !availableLabels.has(name)))
        return invalid(a.invalidTitle, a.labelsInvalid);
      const previous = await getSettings(env, Number(repository), fullName);
      const changed = (Object.keys(value) as (keyof typeof value)[]).filter(
        (key) => JSON.stringify(value[key]) !== JSON.stringify(previous[key]),
      );
      await putSettings(
        env,
        Number(installation),
        Number(repository),
        fullName,
        value,
        user,
      );
      await audit(env, Number(repository), user, "web", "settings.update", { changed });
      return redirect(`${target}&saved=1`);
    }
    const permissions = aiPermissions ?? previewPermissions ?? await repoPermissions(api, fullName, Number(repository));
    if (!permissions.write)
      return withStatus(simple(view, a.title, `<p>${escape(a.writeRequired)}</p><a class="btn" href="${escape(adminLink(view.admin, "/admin/repositories"))}">${escape(a.allRepositories)}</a>`), 404);
    const admin = permissions.admin;
    const [aiProvider, scopedAIEnv] = await Promise.all([
      getAIProvider(env, Number(repository), fullName),
      resolveAIEnv(env, Number(repository), fullName),
    ]);
    const [settings, labels, last, cleanup, log] = await Promise.all([
      getSettings(env, Number(repository), fullName),
      repoLabels(api, fullName),
      lastBackfill(env, Number(repository)),
      latestCleanup(env, Number(repository)),
      recentAudit(env, Number(repository), 20),
    ]);
    // Only a pending preview needs to know who is looking.
    const viewer =
      admin && cleanup?.state === "planned" ? await login() : null;
    const backfillBusy = last?.state === "pending" || last?.state === "running";
    const processingPaused = !settings.issuesEnabled && !settings.prsEnabled;
    const allowed = new Set(settings.allowedLabels);
    const present = new Set(labels.map((x) => x.name));
    const items = [
      ...labels.map((x) => ({ ...x, missing: false })),
      ...settings.allowedLabels
        .filter((name) => !present.has(name))
        .map((name) => ({ name, color: "", description: "", missing: true })),
    ]
      .map(
        (x) =>
          `<li><label class="check"><input type="checkbox" name="allowed_labels" value="${escape(x.name)}"${allowed.has(x.name) ? " checked" : ""}><span class="swatch"${x.color ? ` style="background:#${x.color}"` : ""}></span><span class="grow"><strong>${escape(x.name)}</strong>${x.missing ? ` <span class="state-text" data-state="failed">${escape(a.missing)}</span>` : `<span class="result">${escape(x.description || a.noDescription)}</span>`}</span></label></li>`,
      )
      .join("");
    const box = (name: string, on: boolean, text: string) =>
      `<label class="check"><input type="checkbox" name="${name}" value="on"${on ? " checked" : ""}><span>${escape(text)}</span></label>`;
    const notices = [
      url.searchParams.get("saved") === "1"
        ? `<p class="status" data-on>${escape(a.saved)}</p>`
        : "",
      admin ? "" : `<p class="notice">${escape(a.readOnly)}</p>`,

    ].join("");
    const backfillNotice =
      url.searchParams.get("backfill") === "queued"
        ? `<p class="status" data-on>${escape(a.backfillQueued)}</p>`
        : "";
    const d = ADMIN_MESSAGES[locale];
    const selectedTab = aiAction ? "ai" : path === "/admin/intent-preview" ? "preview" : url.searchParams.get("tab") ?? (url.searchParams.get("backfill") === "queued" ? "backfill" : "settings");
    if (!["settings", "backfill", "cleanup", "activity", "preview", "ai"].includes(selectedTab)) return new Response("Invalid tab", { status: 400 });
    const tabNames = { settings: d.settings, ai: d.aiService, preview: d.preview, backfill: a.backfill, cleanup: a.cleanup, activity: a.activity };
    const tabs = `<nav class="repo-tabs" aria-label="${escape(d.settings)}">${Object.entries(tabNames).map(([id,label])=>`<a href="${escape(adminLink(view.admin!,"/admin/repo",{repository:Number(repository),tab:id}))}"${selectedTab===id?' aria-current="page"':""}>${escape(label)}</a>`).join("")}</nav>`;
    const settingsPanel = `<div class="repo-settings" id="settings"><form method="post" action="${escape(target)}"><input type="hidden" name="csrf" value="${current.id}"><fieldset class="stack"${admin ? "" : " disabled"}><div class="settings-flow">
<section class="setting-section"><div class="setting-description"><h2>${escape(a.processing)}</h2><p>${escape(d.processingHint)}</p></div><div class="setting-controls">${box("issues_enabled", settings.issuesEnabled, a.issues)}${box("prs_enabled", settings.prsEnabled, a.prs)}</div></section>
<section class="setting-section"><div class="setting-description"><h2>${escape(a.comments)}</h2><p>${escape(a.promptHint)}</p></div><div class="setting-controls">${llmConfigured(scopedAIEnv)?"":`<p class="notice">${escape(d.aiGreetingsUnavailable)}</p>`}${box("comments_enabled", settings.commentsEnabled, a.commentsEnabled)}<label class="field"><strong>${escape(a.prompt)}</strong><textarea name="comment_prompt" maxlength="2000" rows="5">\n${escape(settings.commentPrompt)}</textarea></label></div></section>
<section class="setting-section"><div class="setting-description"><h2>${escape(a.triage)}</h2><p>${escape(a.labelsHint)}</p><a class="textlink" href="https://github.com/${escape(fullName)}/labels">${escape(a.editLabels)} ↗</a></div><div class="setting-controls">${triageConfigured(scopedAIEnv)?"":`<p class="notice">${escape(d.previewNotConfigured)}</p>`}${box("triage_enabled", settings.triageEnabled, a.triageEnabled)}<fieldset><legend>${escape(a.labels)}</legend>${items ? `<ul class="labels">${items}</ul>` : `<p class="empty">${escape(a.noLabels)}</p>`}</fieldset></div></section>
</div>${admin?`<div class="settings-save"><p>${escape(d.saveHint)}</p><button class="btn primary">${escape(a.save)}</button></div>`:""}</fieldset></form></div>`;
    const backfillPanel = `<div class="repo-operation"><div class="operation-main">${backfillNotice}${processingPaused ? `<p class="notice">${escape(a.backfillPaused)}</p>` : ""}<form id="backfill" method="post" action="/admin/backfill?${escape(query)}"><input type="hidden" name="csrf" value="${current.id}"><fieldset class="stack"${admin ? "" : " disabled"}><div><h2>${escape(a.backfill)}</h2><p class="result">${escape(a.backfillHint)}</p><p class="result">${escape(a.backfillStatusHint)}</p><label class="field" style="margin-top:12px"><strong>${escape(a.backfillLimit)}</strong><input type="number" name="backfill_limit" min="1" max="100" step="1" required value="${Math.min(Math.max(settings.backfillLimit, 1), 100)}"></label></div><p id="backfill-status" class="result">${escape(a.backfillLast)} ${last ? `<span class="state-text" data-state="${escape(last.state)}">${escape(t.setup.states[last.state as keyof typeof t.setup.states] ?? last.state)}</span> <time datetime="${new Date(last.updated).toISOString()}">${utc(last.updated)} UTC</time>${last.result ? ` · ${escape(last.result)}` : ""}` : escape(a.backfillNever)}</p>${admin ? `<p><button class="btn"${backfillBusy || processingPaused ? " disabled" : ""}>${escape(a.backfillButton)}</button></p>` : ""}</fieldset></form><div class="actions"><a class="btn" href="${escape(target)}&amp;tab=backfill">${escape(a.cleanRefresh)}</a><a class="textlink" href="${escape(adminLink(view.admin!,"/admin/tasks"))}">${escape(d.tasks)}</a></div></div><aside class="operation-help"><h2>${escape(a.backfill)}</h2><p>${escape(d.backfillHelp)}</p></aside></div>`;
    const cleanupPanel = `<div class="repo-operation">${cleanupCard(a, query, current.id, admin, cleanup, viewer)}<aside class="operation-help"><h2>${escape(a.cleanup)}</h2><p>${escape(d.cleanupHelp)}</p></aside></div>`;
    const activityPanel = `<div class="repo-operation">${activityCard(a,log,locale)}<aside class="operation-help"><h2>${escape(d.activity)}</h2><p>${escape(d.activityLead)}</p><div class="actions"><a class="btn" href="${escape(adminLink(view.admin!,"/admin/activity"))}">${escape(d.viewAll)}</a></div></aside></div>`;
    const previewErrors = { invalid_input: d.previewInvalid, no_candidates: d.previewNoCandidates, not_configured: d.previewNotConfigured, rate_limited: d.previewRateLimited, classifier_unavailable: d.previewUnavailable };
    const previewTitle = previewResult?.title ?? (form?.get("preview_title") ?? "").slice(0,256);
    const previewBody = previewResult?.body ?? (form?.get("preview_body") ?? "").slice(0,8000);
    const previewKind = previewResult?.kind ?? (form?.get("preview_kind") === "pull_request" ? "pull_request" : "issue");
    const classification = previewResult?.classification;
    const previewOutput = previewError ? `<p class="notice" role="alert">${escape(previewErrors[previewError])}</p>` : classification ? `<div class="operation-main"><h2>${escape(d.previewSelected)}</h2><p>${classification.labels.length?classification.labels.map(name=>`<span class="state-text" data-state="done"><bdi>${escape(name)}</bdi></span>`).join(" "):escape(d.previewNoMatch)}</p><p class="result">${escape(d.previewCandidates)}: ${previewResult!.candidateCount} · ${escape(classification.provider)}${classification.model?` · <bdi>${escape(classification.model)}</bdi>`:""}${classification.threshold!==undefined?` · ${escape(d.previewThreshold)}: ${Math.round(classification.threshold*100)}%`:""}</p>${classification.probabilities?.length?`<div class="probabilities">${classification.probabilities.map(x=>`<div class="probability"><bdi>${escape(x.name)}</bdi><span dir="ltr">${(x.probability*100).toFixed(1)}%</span><meter min="0" max="1" value="${x.probability}" aria-label="${escape(x.name)}"></meter></div>`).join("")}</div>`:""}</div>` : "";
    const previewPanel = `<div class="repo-operation"><div class="stack"><div class="operation-main"><h2>${escape(d.preview)}</h2><p class="result">${escape(d.previewLead)}</p><form class="preview-form" method="post" action="/admin/intent-preview?${escape(query)}"><input type="hidden" name="csrf" value="${current.id}"><fieldset class="stack"${admin?"":" disabled"}><label class="field"><strong>${escape(d.previewKind)}</strong><select name="preview_kind"><option value="issue"${previewKind!=="pull_request"?" selected":""}>${escape(d.issue)}</option><option value="pull_request"${previewKind==="pull_request"?" selected":""}>${escape(d.pullRequest)}</option></select></label><label class="field"><strong>${escape(d.previewTitle)}</strong><input type="text" name="preview_title" required maxlength="256" value="${escape(previewTitle)}"></label><label class="field"><strong>${escape(d.previewBody)}</strong><textarea name="preview_body" maxlength="8000" rows="5">${escape(previewBody)}</textarea></label>${admin?`<button class="btn primary">${escape(d.runPreview)}</button>`:""}</fieldset></form><p class="result">${escape(d.previewOnly)}</p></div>${previewOutput}</div><aside class="operation-help"><h2>${escape(d.preview)}</h2><p>${escape(d.previewDisclosure)}</p>${triageConfigured(scopedAIEnv)?"":`<p class="notice">${escape(d.previewNotConfigured)}</p>`}<p class="result">${escape(d.previewCandidates)}: ${settings.allowedLabels.filter(name=>present.has(name)).length}</p><a class="textlink" href="${escape(adminLink(view.admin!,"/admin/repo",{repository:Number(repository),tab:"settings"}))}">${escape(d.settings)}</a></aside></div>`;
    const aiErrors: Record<AIProviderError["code"], string> = { invalid_config: d.aiInvalid, key_required: d.aiKeyRequired, storage_unavailable: d.aiStorageUnavailable, unavailable: d.aiUnavailable, rate_limited: d.aiRateLimited };
    const aiMessages = { saved: d.aiSaved, tested: d.aiTested, removed: d.aiRemoved };
    const aiResult = url.searchParams.get("ai") ?? "";
    const aiFeedback = aiError ? `<p class="notice" role="alert">${escape(aiErrors[aiError])}</p>` : ["saved", "tested", "removed"].includes(aiResult) ? aiMessages[aiResult as keyof typeof aiMessages] : "";
    const aiTarget = (path: string) => adminLink(view.admin!, path, { repository: Number(repository) });
    const aiPanel = `<div class="repo-settings" id="ai-service"><noscript><style>[data-key-visibility]{display:none}</style></noscript>${aiFeedback ? (aiError ? aiFeedback : `<p class="status" role="status" data-on>${escape(aiFeedback)}</p>`) : ""}
<form class="ai-provider-form" data-settings-form method="post" action="${escape(aiTarget("/admin/ai-provider"))}"><input type="hidden" name="csrf" value="${current.id}"><fieldset${admin ? "" : " disabled"}><div class="settings-flow">
<section class="setting-section"><div class="setting-description"><h2>${escape(d.aiMode)}</h2><p>${escape(d.aiLead)}</p><p>${escape(d.aiPrivacy)}</p><p>${escape(d.aiNoFallback)}</p></div><div class="setting-controls"><label class="check"><input type="radio" name="mode" value="platform"${aiProvider.mode === "platform" ? " checked" : ""}><span>${escape(d.aiPlatform)}</span></label><label class="check"><input type="radio" name="mode" value="byok"${aiProvider.mode === "byok" ? " checked" : ""}><span>${escape(d.aiByok)}</span></label><p class="result" data-ai-platform-hint>${escape(d.aiPlatformHint)}</p><p class="result">${escape(d.aiSavedConfiguration)}: ${escape(aiProvider.mode === "platform" ? d.aiPlatform : d.aiByok)} · ${escape(aiProvider.ready ? d.aiReady : d.aiNotReady)}</p>${aiProvider.storageAvailable ? "" : `<p class="notice">${escape(d.aiStorageUnavailable)}</p>`}</div></section>
<section class="setting-section" data-ai-byok-fields><div class="setting-description"><h2>${escape(d.aiByok)}</h2><p>${escape(d.aiCapabilities)}</p></div><div class="setting-controls ai-fields"><label class="field"><strong>${escape(d.aiProtocol)}</strong><select name="provider"><option value="llm"${aiProvider.provider === "llm" ? " selected" : ""}>${escape(d.aiOpenAI)}</option><option value="jev"${aiProvider.provider === "jev" ? " selected" : ""}>${escape(d.aiJev)}</option></select></label><label class="field"><strong>${escape(d.aiBaseUrl)}</strong><input type="url" name="base_url" dir="ltr" maxlength="2000" value="${escape(aiProvider.mode === "byok" ? aiProvider.baseUrl : "")}" spellcheck="false" autocomplete="off" placeholder="https://api.example.com/v1"></label><label class="field"><strong>${escape(d.aiModel)}</strong><input type="text" name="model" dir="ltr" maxlength="200" value="${escape(aiProvider.mode === "byok" ? aiProvider.model : "")}" spellcheck="false" autocomplete="off" aria-describedby="ai-model-hint"></label><p class="result" id="ai-model-hint">${escape(d.aiModelHint)}</p><label class="field" for="ai-api-key"><strong>${escape(d.aiKey)}</strong></label><div class="credential-field"><input id="ai-api-key" type="password" name="api_key" dir="ltr" maxlength="4096" autocomplete="new-password" spellcheck="false" aria-describedby="ai-key-state ai-key-hint"><button class="btn" type="button" data-key-visibility aria-controls="ai-api-key" aria-pressed="false" data-show="${escape(d.aiShowKey)}" data-hide="${escape(d.aiHideKey)}">${escape(d.aiShowKey)}</button></div><p class="result" id="ai-key-state">${escape(aiProvider.mode === "byok" && aiProvider.hasKey ? d.aiKeySaved : d.aiKeyMissing)}</p><p class="result" id="ai-key-hint">${escape(d.aiKeyHint)}</p></div></section>
</div>${admin ? `<div class="settings-save"><p>${escape(d.saveHint)}</p><button class="btn primary">${escape(d.aiSave)}</button></div>` : ""}</fieldset></form>
<section class="setting-section"><div class="setting-description"><h2>${escape(d.aiTest)}</h2><p>${escape(d.aiTestHint)}</p></div><div class="setting-controls"><form method="post" action="${escape(aiTarget("/admin/ai-provider/test"))}"><input type="hidden" name="csrf" value="${current.id}"><button class="btn"${admin && aiProvider.ready ? "" : " disabled"}>${escape(d.aiTest)}</button></form></div></section>
${aiProvider.mode === "byok" && aiProvider.hasKey ? `<section class="setting-section"><div class="setting-description"><h2>${escape(d.aiRemove)}</h2><p>${escape(d.aiKeySaved)}</p></div><div class="setting-controls"><form method="post" action="${escape(aiTarget("/admin/ai-provider/remove"))}"><input type="hidden" name="csrf" value="${current.id}"><fieldset class="stack"${admin ? "" : " disabled"}><label class="check"><input type="checkbox" name="confirm_remove" value="yes" required><span>${escape(d.aiRemoveConfirm)}</span></label><button class="btn">${escape(d.aiRemove)}</button></fieldset></form></div></section>` : ""}</div>`;
    const panels = { settings: settingsPanel, backfill: backfillPanel, cleanup: cleanupPanel, activity: activityPanel, preview: previewPanel, ai: aiPanel };
    return withStatus(html(view,fullName,`<nav class="crumbs"><a class="textlink" href="${escape(adminLink(view.admin!,"/admin/repositories"))}">${escape(d.repositories)}</a><span>${escape(admin?d.admin:d.readOnly)}</span></nav>${pageHead(fullName,selectedTab==="settings"?d.settingsHint:selectedTab==="ai"?d.aiLead:tabNames[selectedTab as keyof typeof tabNames],selectedTab==="settings"?`<a class="btn" href="${escape(aiTarget("/admin/repo"))}&amp;tab=ai">${escape(d.aiService)}</a>`:"")}${notices?`<div class="notice-stack">${notices}</div>`:""}${tabs}${panels[selectedTab as keyof typeof panels]}`),aiAction ? aiStatus : previewStatus);

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
    view.session = current.id;
    const api = github(current.token);
    const repos = await accessibleRepos(api, installation);
    if (path === "/retry" && request.method === "POST") {
      if (request.headers.get("origin") !== url.origin)
        return new Response("Invalid origin", { status: 403 });
      const form = new URLSearchParams(await readTextBounded(request));
      if (form.get("csrf") !== current.id)
        return new Response("Invalid form", { status: 403 });
      const returnsToTasks = form.get("return_to") === "tasks";
      const returnParams = new URLSearchParams({ installation_id: installation });
      if (url.searchParams.get("lang") === locale) returnParams.set("lang", locale);
      if (returnsToTasks) {
        try { parseAdminFilters(url.searchParams); }
        catch { return new Response("Invalid filters", { status: 400 }); }
        for (const key of ["repo_page", "q", "repository", "status", "kind", "task_page"]) {
          const value = url.searchParams.get(key);
          if (value) returnParams.set(key, value);
        }
      }
      const job = await env.DB.prepare(
        "SELECT * FROM jobs WHERE id=? AND installation=? AND state='failed'",
      )
        .bind(form.get("id"), Number(installation))
        .first<Job>();
      if (!job?.repository || !repos.has(job.repository))
        return new Response("Not found", { status: 404 });
      if (!(await repoPermissions(api, repos.get(job.repository)!, job.repository)).admin)
        return new Response("Repository admin required", { status: 403 });
      await retryJob(env, job, Number(installation), repos.get(job.repository)!);
      await dispatch(env);
      return redirect(`${returnsToTasks ? "/admin/tasks" : "/setup"}?${returnParams}`);
    }
    if (request.method !== "GET")
      return new Response("Method not allowed", { status: 405 });
    // Scope before LIMIT so unrelated repository jobs cannot displace the
    // user's visible items. Small CTE batches respect D1's bind-parameter cap.
    // The top 100 of their union must be in the top 100 of these sorted batches.
    const candidates: Job[] = [];
    const members = [...repos];
    for (let start = 0; start < members.length; start += 25) {
      const batch = members.slice(start, start + 25);
      const { results: rows } = await env.DB.prepare(
        `WITH permitted(repository,fullName) AS (VALUES ${batch.map(() => "(?,?)").join(",")})
         SELECT j.* FROM jobs j JOIN permitted p ON p.repository=j.repository
         WHERE j.installation=? AND lower(substr(j.full_name,1,instr(j.full_name,'/')-1))=lower(substr(p.fullName,1,instr(p.fullName,'/')-1))
         ORDER BY lower(p.fullName) ASC,j.repository ASC,${JOINED_JOB_ITEM_ORDER_SQL} LIMIT 100`,
      ).bind(...batch.flatMap(([id, name]) => [id, name]), Number(installation)).all<Job>();
      candidates.push(...rows);
    }
    const results = candidates.sort((a,b) => compareJobsByItem(
      { ...a, fullName: repos.get(a.repository!) }, { ...b, fullName: repos.get(b.repository!) },
    )).slice(0,100);
    const accessible = results.filter((x) => x.repository && repos.has(x.repository));
    const permissions = new Map(await Promise.all(
      [...new Set(accessible.map((x) => x.repository!))].map(async (id) =>
        [id, await repoPermissions(api, repos.get(id)!, id)] as const),
    ));
    const visible = accessible.filter((x) => permissions.get(x.repository!)?.write);
    const kind = (value: string) =>
      escape(s.kinds[value as keyof typeof s.kinds] ?? value);
    const state = (value: string) =>
      escape(s.states[value as keyof typeof s.states] ?? value);
    const rows = visible
      .map(
        (job) =>
          `<tr><td><a href="https://github.com/${escape(repos.get(job.repository!))}/labels">${escape(repos.get(job.repository!))}</a></td><td>${kind(job.kind)}${job.pr ? ` #${job.pr}` : ""}</td><td><span class="pill" data-state="${escape(job.state)}">${state(job.state)}</span>${job.result ? `<span class="result">${escape(job.result)}</span>` : ""}</td><td>${job.state === "failed" && permissions.get(job.repository!)?.admin ? `<form method="post" action="/retry?installation_id=${installation}"><input type="hidden" name="csrf" value="${current.id}"><input type="hidden" name="id" value="${escape(job.id)}"><button class="btn">${escape(s.retry)}</button></form>` : ""}</td></tr>`,
      )
      .join("");
    return html(
      view,
      s.title,
      `<h1 style="font-size:clamp(26px,3.4vw,34px);letter-spacing:-.8px;font-weight:650">${escape(s.title)}</h1><p class="lead" style="margin-top:8px">${escape(s.refresh)} <a class="textlink" href="/admin?installation_id=${installation}">${escape(t.admin.title)}</a></p><div class="card table">${visible.length ? `<table><thead><tr><th>${escape(s.repository)}</th><th>${escape(s.task)}</th><th>${escape(s.status)}</th><th>${escape(s.action)}</th></tr></thead><tbody>${rows}</tbody></table>` : `<p class="empty">${escape(s.empty)}</p>`}</div>`,
    );
  }
  return new Response("Not found", { status: 404 });
}
async function readTextBounded(request: Request, limit = 4096) {
  const { readText } = await import("./github");
  return readText(request, AbortSignal.timeout(5000), limit);
}

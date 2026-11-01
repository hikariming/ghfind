/** Real local Worker acceptance. Run sequentially against dev-dashboard.mts
 * --installations=0, =1, =2 WITHOUT --jev. No real model calls: QA requires a disabled provider.
 * pnpm exec tsx platform/github-app/scripts/dashboard-ux-acceptance.mts --out=/tmp/dashboard-ux
 */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright";
const args = process.argv.slice(2);
const base = "http://127.0.0.1:4201";
const out = resolve(args.find(x => x.startsWith("--out="))?.slice(6) || "/tmp/ghfind-dashboard-ux");
const baseline = args.includes("--baseline");
const focused = args.includes("--scoped-screens");
const screensOnly = args.includes("--screens-only") || focused, checksOnly = args.includes("--checks-only");
assert(args.every(x => ["--baseline", "--screens-only", "--checks-only", "--scoped-screens"].includes(x) || x.startsWith("--out=")), "Usage: dashboard-ux-acceptance.mts [--baseline|--screens-only|--checks-only|--scoped-screens] [--out=directory]");
await mkdir(out, { recursive: true });
const health = await (await fetch(base + "/__preview/health")).json();
assert.equal(health.fixture, true);
if (!baseline) assert.equal(health.model, "disabled", "QA must run without --jev");
if (!baseline) {
 const stale = "00000000-0000-4000-8000-000000000001";
 const refreshed = await fetch(base + (health.installationCount ? "/admin?installation_id=10&lang=en" : "/admin/installations?lang=en"), { headers: { cookie: `ghfind_bot_session=${stale}; ghfind_bot_lang=zh` } });
 assert.equal(refreshed.status, 200); assert(refreshed.headers.getSetCookie().some(cookie => cookie.startsWith("ghfind_bot_session="))); assert(refreshed.headers.getSetCookie().some(cookie => cookie.startsWith("ghfind_bot_lang=en")), "Locale and refreshed session cookies coexist"); assert((await refreshed.text()).includes(health.installationCount ? "<h1>Dashboard</h1>" : "<h1>Installations</h1>"));
 const denied = await fetch(base + "/admin/toggle?installation_id=10&repository=100", { method: "POST", headers: { cookie: `ghfind_bot_session=${stale}`, Origin: base, "content-type": "application/x-www-form-urlencoded" }, body: `csrf=${stale}&enabled=off` });
 assert.equal(denied.status, 403, "Old supplied POST session cannot be refreshed/bypass CSRF");
 const signedout = await fetch(base + "/admin?signedout=1&lang=en"); assert.equal(signedout.status, 200); assert((await signedout.text()).includes('href="/login?return_to=admin"'), "Explicit signed-out fixture uses real authentication UI");
}
const browser = await chromium.launch({ headless: true, ignoreDefaultArgs: ["--disable-back-forward-cache"] });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
if (!baseline) await page.context().addCookies([{ name: "ghfind_bot_session", value: "00000000-0000-4000-8000-000000000001", url: base }, { name: "ghfind_bot_lang", value: "zh", url: base }]);
const errors: string[] = [], checks: unknown[] = [], matrix: unknown[] = [], pageshows: { url: string; persisted: boolean }[] = [];
await page.addInitScript('addEventListener("pageshow", event => console.log("QA_PAGESHOW:" + event.persisted))');
page.on("console", message => { if (message.text().startsWith("QA_PAGESHOW:")) pageshows.push({ url: page.url(), persisted: message.text().endsWith("true") }); });
page.on("pageerror", e => errors.push(e.message));
const routes = ["/admin", "/admin/repositories", "/admin/tasks", "/admin/activity", "/admin/installations"];
const names = ["Dashboard", "Repositories", "Tasks", "Activity", "Installations"];
const go = async (path: string) => { const response = await page.goto(base + path); assert.equal(response?.status(), 200, path); await page.evaluate(() => document.fonts.ready); };
const nav = async (action: () => Promise<unknown>) => { const [response] = await Promise.all([page.waitForNavigation({ timeout: 10_000 }), action()]); assert.equal(response?.status(), 200); };
const side = (path: string) => page.locator(".side-link").filter({ has: page.locator(`xpath=self::a[starts-with(@href,"${path}?")]`) });
const screenshot = async (file: string) => page.screenshot({ path: resolve(out, file), fullPage: true });
const allAccounts = () => page.locator('.account-popover nav a').filter({ hasText: "All accounts" });
const account = (id: number) => page.locator(`.account-popover nav a[href*="installation_id=${id}"]`);
try {
 if (baseline) {
  for (const [i, path] of routes.slice(0, 4).entries()) {
   await go("/admin?installation_id=10&lang=en"); await nav(() => side("/admin/installations").click());
   const before = { url: page.url(), heading: await page.locator("h1").textContent(), links: await page.locator(".side-link").evaluateAll(xs => xs.map(x => x.getAttribute("href"))) };
   await nav(() => page.locator(".side-link").filter({ hasText: names[i] }).click());
   checks.push({ clicked: path, before, after: page.url(), heading: await page.locator("h1").textContent(), nativeSelect: await page.locator("#installation-context").count() });
   await screenshot(`before-${i}.png`);
  }
 } else {
  const count = health.installationCount;
  assert([0, 1, 2].includes(count), "Harness must expose explicit account fixture mode");
  await go("/admin/installations?lang=en");
  assert.equal(await page.locator("#installation-context").count(), 0, "No native account select");
  assert.equal(await page.locator(".installation-directory tbody tr").count(), count);
  if (count === 0) {
   assert.equal(await page.locator(".admin-empty").count(), 1); assert.equal(await page.locator(".context .context-badge, .context-manage, [data-account-picker]").count(), 0); assert.equal(await page.locator(".context .account-name").textContent(), "Installations");
   assert((await page.locator('.admin-empty a[href*="github.com/apps/"]').count()) > 0, "Empty state offers installation action");
   for (const link of await page.locator(".side-link").evaluateAll(xs => xs.map(x => x.getAttribute("href")))) assert(!link?.includes("installation_id="));
   await go("/admin?lang=en"); assert.equal(await page.locator("h1").textContent(), "Dashboard"); assert.equal(await page.locator(".admin-empty").count(), 1); assert.equal(await page.locator(".kpi-value, [data-account-picker]").count(), 0); assert.equal(await page.locator(".context .account-name").textContent(), "All accounts"); assert((await page.locator('.admin-empty a[href*="github.com/apps/"]').count()) > 0);
   checks.push("Zero accounts: global Dashboard and directory are actionable empty states with no invented counts or invalid account links");
  } else if (!screensOnly) {
   assert.equal(new URL(page.url()).searchParams.get("installation_id"), null); // resolution is server-side
   await go("/admin?lang=en");
   assert.equal(await page.locator("h1").textContent(), "Dashboard");
   assert.equal(health.seedRows.repositories, count === 2 ? 4 : 3); assert.equal(health.seedRows.jobs, count === 2 ? 41 : 37);
   assert.deepEqual(await page.locator(".kpi-value").allTextContents(), count === 2 ? ["4", "41", "12", "7"] : ["3", "37", "12", "6"]);
   assert.equal(await page.locator(".work-section").first().locator("tbody tr").count(), count);
   assert.equal(await page.locator("[data-account-picker]").count(), 1, "Global context exposes All accounts even with a single installation");
   const globalLinks = await page.locator("main a[href*='repository='], main form[action^='/retry?']").evaluateAll(xs => xs.map(x => ({ url: x.getAttribute(x.tagName === "FORM" ? "action" : "href")!, repositoryUrl: x.closest("tr")?.querySelector("a.repo-name")?.getAttribute("href") })));
   assert(globalLinks.length > 0);
   for (const link of globalLinks) { const url = new URL(link.url, base); const repo = Number(url.searchParams.get("repository") || (link.repositoryUrl ? new URL(link.repositoryUrl, base).searchParams.get("repository") : null)); if (repo) assert.equal(url.searchParams.get("installation_id"), repo === 400 ? "20" : "10", "Global job/audit links retain row installation"); }
   checks.push(`Global Dashboard sums genuine D1 rows across ${count} account(s) and retains row-specific drill-down installation`);
   if (count === 2) {
    await nav(() => page.locator(".work-section").first().locator("a.repo-name").filter({ hasText: "harbor" }).click());
    assert.equal(new URL(page.url()).searchParams.get("installation_id"), "20");
    assert.deepEqual(await page.locator(".kpi-value").allTextContents(), ["1", "4", "0", "1"]);
    assert(!(await page.locator("main").textContent())?.includes("sample/"));
    await page.locator("[data-account-picker] summary").click(); await nav(() => allAccounts().click());
    assert.deepEqual([...new URL(page.url()).searchParams.keys()], ["lang"]); assert.equal(await page.locator(".account-name").textContent(), "All accounts");
    checks.push("Native account drill-down scopes counts; All accounts returns to aggregate without stale repository filters");
   }
   await go("/admin?installation_id=10&lang=en");
   if (count === 1) { assert.equal(await page.locator("[data-account-picker]").count(), 0); assert.equal(await page.locator(".account-static .account-name").textContent(), "sample"); }
   for (const [i, path] of routes.slice(0, -1).entries()) {
    await go("/admin/installations?installation_id=10&lang=en"); await nav(() => side(path).click());
    assert.equal(new URL(page.url()).pathname, path); assert.equal(new URL(page.url()).searchParams.get("installation_id"), path === "/admin" ? null : "10");
    assert.equal(await page.locator("h1").textContent(), names[i]);
    await page.goBack(); assert.equal(new URL(page.url()).pathname, "/admin/installations"); assert.equal(new URL(page.url()).searchParams.get("installation_id"), "10");
    checks.push(`Installations → ${names[i]} → browser Back restores selected installation; Dashboard is global`);
   }
   await go("/admin/repositories?installation_id=10&lang=en");
   await page.locator("input[name=q]").fill("platform-sdk"); assert.equal(new URL(page.url()).searchParams.get("q"), "platform-sdk"); assert.equal(await page.locator("[data-repo-row]:visible").count(), 1);
   await page.reload(); assert.equal(await page.locator("input[name=q]").inputValue(), "platform-sdk"); assert.equal(await page.locator("[data-repo-row]:visible").count(), 1);
   await page.locator("[data-search-clear]").click(); assert.equal(new URL(page.url()).searchParams.has("q"), false); assert.equal(await page.locator("input[name=q]").inputValue(), ""); assert.equal(await page.locator("input[name=q]").evaluate(x => x === document.activeElement), true);
   await page.locator("select[name=processing]").selectOption("paused"); assert.equal(new URL(page.url()).searchParams.get("processing"), "paused"); assert.equal(await page.locator("[data-repo-row]:visible").count(), 1);
   checks.push("Local repository filters synchronize URL, reload, clear and focus");
   const displayedJobs: { repository: string; number: number | null }[] = [];
   for (const taskPage of [1, 2]) {
    await go(`/admin/tasks?installation_id=10&lang=en&task_page=${taskPage}`);
    const rows = await page.locator(".work-section").first().locator("tbody tr").evaluateAll(xs => xs.map(x => ({ repository: x.querySelector(".repo-name")?.textContent || "", number: Number(x.querySelector("a[href*='/issues/']")?.getAttribute("href")?.split("/").pop()) || null })));
    assert.equal(rows.length, taskPage === 1 ? 25 : 12); displayedJobs.push(...rows);
   }
   for (let i = 1; i < displayedJobs.length; i++) { const previous = displayedJobs[i-1], current = displayedJobs[i]; assert(previous.repository.localeCompare(current.repository) <= 0); if (previous.repository === current.repository) assert((previous.number ?? Infinity) <= (current.number ?? Infinity), "Shared Issue/PR number order remains stable across SQL pagination"); }
   checks.push("Issue/PR lookup orders canonical repository and shared GitHub number before 25-row pagination (37 retained jobs)");
   if (count === 2) {
    for (const path of [...routes, "/admin/repo"]) {
     const params = path === "/admin/repo" ? "&repository=100&tab=settings" : "&q=sample&status=failed&task_page=2&activity_page=2";
     await go(path + "?installation_id=10&lang=en" + params);
     console.log(JSON.stringify({ switching: path })); await page.locator("[data-account-picker] summary").click(); await nav(() => account(20).click());
     const target = new URL(page.url()); assert.equal(target.pathname, path === "/admin/repo" ? "/admin/repositories" : path); assert.deepEqual([...target.searchParams.keys()].sort(), ["installation_id", "lang"]); assert.equal(target.searchParams.get("installation_id"), "20"); assert.equal(await page.locator(".account-name").textContent(), "harbor");
     assert(!(await page.locator("main").textContent())?.includes("sample/"), "Account20 never exposes sample repository data");
    }
    checks.push("Two accounts switch across every route; repo detail returns to repositories; query filters reset; tenant data remains isolated");
    await go("/admin?installation_id=10&lang=en"); const picker = page.locator("[data-account-picker]"), trigger = picker.locator("summary");
    await trigger.focus(); await page.keyboard.press("ArrowDown"); assert.equal(await allAccounts().evaluate(x => x === document.activeElement), true); await page.keyboard.press("ArrowDown"); assert.equal(await account(10).evaluate(x => x === document.activeElement), true); await page.keyboard.press("ArrowDown"); assert.equal(await account(20).evaluate(x => x === document.activeElement), true); await page.keyboard.press("Escape"); await page.waitForFunction(() => document.querySelector("[data-account-picker] summary")?.getAttribute("aria-expanded") === "false"); assert.equal(await trigger.getAttribute("aria-expanded"), "false"); assert.equal(await trigger.evaluate(x => x === document.activeElement), true);
    await trigger.click(); await page.locator(".admin-main").click({ position: { x: 600, y: 30 } }); await page.waitForFunction(() => !(document.querySelector("[data-account-picker]") as HTMLDetailsElement)?.open); assert.equal(await picker.evaluate(x => (x as HTMLDetailsElement).open), false);
    checks.push("Account menu keyboard traversal, Escape focus restoration and outside close");
   }
   await go("/admin/repositories?installation_id=10&lang=en");
   await page.locator("input[name=q]").fill("maintainer-dashboard");
   await nav(() => page.locator("[data-repo-settings]:visible").first().click());
   assert.equal(new URL(page.url()).searchParams.get("return_q"), "maintainer-dashboard");
   await page.locator("textarea[name=comment_prompt]").fill("Unsaved local acceptance input");
   const beforeCancel = page.url(); page.once("dialog", dialog => dialog.dismiss());
   await page.locator(".crumbs a").click(); assert.equal(page.url(), beforeCancel);
   page.once("dialog", dialog => dialog.dismiss()); await page.locator("#lang").selectOption("zh");
   assert.equal(await page.locator("#lang").inputValue(), "en"); assert.equal(page.url(), beforeCancel);
   let logoutPosts = 0; page.on("request", request => { if (request.method() === "POST" && new URL(request.url()).pathname === "/logout") logoutPosts++; });
   page.once("dialog", dialog => dialog.dismiss()); await page.locator(".session-signout").click();
   assert.equal(logoutPosts, 0); assert.equal(page.url(), beforeCancel); assert.equal(await page.locator("textarea[name=comment_prompt]").inputValue(), "Unsaved local acceptance input"); assert.equal(await page.locator('.side-bottom form[data-pending], .side-bottom form[aria-busy="true"]').count(), 0);
   checks.push("Unsaved sign-out cancel preserves session/input and produces no pending lock or logout POST");
   page.once("dialog", dialog => dialog.accept()); await nav(() => page.locator(".crumbs a").click());
   assert.equal(new URL(page.url()).searchParams.get("q"), "maintainer-dashboard"); assert.equal(await page.locator("[data-repo-row]:visible").count(), 1);
   checks.push("Settings retains list filter context; unsaved link/language cancel preserves input; accepted return restores filter");
   await page.setViewportSize({ width: 390, height: 400 }); await go("/admin?installation_id=10&lang=en");
   await page.locator("[data-menu-button]").click(); await page.locator(".side-bottom").scrollIntoViewIfNeeded(); assert.equal(await page.locator(".session-signout").isVisible(), true);
   await nav(() => side("/admin/repositories").click()); await page.goBack();
   assert.equal(await page.locator("[data-menu-button]").getAttribute("aria-expanded"), "false"); assert.equal(await page.locator(".admin-workspace").evaluate(x => (x as HTMLElement).inert), false); assert.notEqual(await page.locator("body").evaluate(x => x.style.overflow), "hidden");
   checks.push("Short-height mobile drawer bottom remains reachable; browser Back restores drawer, inert and scrolling state");
   await page.setViewportSize({ width: 1440, height: 1000 });
   await go("/admin/repo?installation_id=10&repository=100&tab=preview&lang=zh");
   await page.locator("[name=preview_title]").fill("Local unavailable provider acceptance"); await page.locator("[name=preview_body]").fill("The CLI crashes when its configuration file is missing.");
   const [previewResponse] = await Promise.all([page.waitForNavigation(), page.locator(".preview-form button").click()]);
   assert.equal(previewResponse?.status(), 503); assert.equal(new URL(page.url()).searchParams.get("lang"), "zh"); assert.equal(await page.locator("[name=preview_title]").inputValue(), "Local unavailable provider acceptance"); assert.equal(await page.locator("[role=alert]").count(), 1);
   checks.push("Unavailable model preview returns503 with localized alert and retained input; no key/model calls");
   // Delay only the real local POST transport; no response or classifier is mocked.
   await go("/admin/repo?installation_id=10&repository=100&lang=en");
   const form = page.locator('form[action^="/admin/repo?"]');
   let posts = 0;
   let releasePost!: () => void; const postGate = new Promise<void>(done => { releasePost = done; });
   await page.route("**/admin/repo?**", async route => { if (route.request().method() === "POST") { posts++; await postGate; } await route.continue(); });
   const submit = form.locator('button:not([type="button"])').first();
   await submit.scrollIntoViewIfNeeded(); const position = await submit.boundingBox(); assert(position);
   const savedResponse = page.waitForResponse(response => response.request().method() === "POST" && new URL(response.url()).pathname === "/admin/repo");
   const pendingEvidence = page.waitForEvent("console", { predicate: message => message.text().startsWith("QA_PENDING:"), timeout: 5000 });
   await page.evaluate(() => { const form = document.querySelector('form[action^="/admin/repo?"]')!; document.addEventListener("submit", () => { const button = form.querySelector('button:not([type="button"])') as HTMLButtonElement; console.log("QA_PENDING:" + JSON.stringify({ busy: form.getAttribute("aria-busy"), pending: form.hasAttribute("data-pending"), buttonAria: button.getAttribute("aria-disabled"), disabled: button.disabled, status: form.querySelectorAll('.form-pending[role="status"]').length })); }); });
   await page.mouse.click(position.x + position.width / 2, position.y + position.height / 2);
   const pending = JSON.parse((await pendingEvidence).text().slice("QA_PENDING:".length));
   assert.deepEqual(pending, { busy: "true", pending: true, buttonAria: "true", disabled: false, status: 1 });
   await page.mouse.click(position.x + position.width / 2, position.y + position.height / 2);
   releasePost(); assert.equal((await savedResponse).status(), 303, "Fresh GET session+locale cookie enables first real POST"); await page.waitForURL(/saved=1/); assert.equal(posts, 1); assert.equal(await page.locator("form[data-pending]").count(), 0);
   await page.unroute("**/admin/repo?**"); await page.goBack(); assert.equal(await page.locator("form[data-pending]").count(), 0); assert.equal(await page.locator(".form-pending").count(), 0);
   checks.push("Real settings POST shows pending feedback, blocks duplicate submission and resets on return");
  }
  if (count && !focused) {
   const nojs = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 390, height: 400 } });
   const nojsPage = await nojs.newPage(); try { const response = await nojsPage.goto(base + "/admin/installations?installation_id=10&lang=en"); assert.equal(response?.status(), 200); assert.equal(await nojsPage.locator(".side-link").filter({ hasText: "Repositories" }).isVisible(), true); await Promise.all([nojsPage.waitForNavigation(), nojsPage.locator(".side-link").filter({ hasText: "Repositories" }).click()]); assert.equal(await nojsPage.locator("h1").textContent(), "Repositories"); await nojsPage.screenshot({ path: resolve(out, "mobile-no-js.png"), fullPage: true }); checks.push("Mobile navigation remains usable without JavaScript"); } finally { await nojs.close(); }
  }
  const captures = focused ? [
   { key: "account", path: "/admin", scoped: true },
   ...(count === 2 ? [{ key: "global", path: "/admin", scoped: false }, { key: "settings", path: "/admin/repo?repository=100", scoped: true }, { key: "settings-preview", path: "/admin/repo?repository=100&tab=preview", scoped: true }] : []),
  ] : count ? [
   { key: "global", path: "/admin", scoped: false }, { key: "account", path: "/admin", scoped: true },
   ...routes.slice(1).map(path => ({ key: path.split("/").pop()!, path, scoped: true })),
   { key: "settings", path: "/admin/repo?repository=100", scoped: true },
   ...(count === 2 ? ["preview", "backfill", "cleanup", "activity"].map(tab => ({ key: `settings-${tab}`, path: `/admin/repo?repository=100&tab=${tab}`, scoped: true })) : []),
  ] : [{ key: "global", path: "/admin", scoped: false }, { key: "installations", path: "/admin/installations", scoped: false }];
  if (!checksOnly) for (const lang of ["en", "zh", "ar"]) for (const mobile of [false, true]) {
   await page.setViewportSize(mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 });
   for (const capture of captures) for (const theme of ["light", "dark", "auto"]) {
    const { path, key, scoped } = capture;
    if (focused && key === "global" && !(["en", "zh"].includes(lang) && !mobile && theme !== "auto")) continue;
    if (focused && key === "settings" && !((["en", "zh"].includes(lang) && !mobile && theme !== "auto") || (lang === "ar" && mobile))) continue;
    if (key.startsWith("settings-") && !((lang === "en" && !mobile) || (lang === "ar" && mobile))) continue;
    await page.emulateMedia({ colorScheme: theme === "light" ? "light" : "dark" });
    await go(path + (path.includes("?") ? "&" : "?") + (scoped ? "installation_id=10&" : "") + "lang=" + lang);
    await page.locator(`[data-theme-choice=${theme}]`).click();
    if (theme === "auto") { await page.emulateMedia({ colorScheme: "light" }); const light = await page.evaluate(() => getComputedStyle(document.body).backgroundColor); await page.emulateMedia({ colorScheme: "dark" }); const dark = await page.evaluate(() => getComputedStyle(document.body).backgroundColor); assert.notEqual(light, dark, "Auto follows resolved OS theme"); }
    await page.evaluate(async () => { await Promise.all(document.getAnimations().map(animation => animation.finished.catch(() => {}))); });
    assert.equal(await page.locator("main .card, main .pill").count(), 0, "Operational admin surfaces use flat rows and state text");
    assert.equal(await page.locator("html").getAttribute("lang"), lang); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `overflow ${path} ${lang} ${theme}`);
    let auditGeometry: unknown;
    if (key === "account" && focused) { const auditWidth = await page.locator(".workspace-split .audit-table").evaluate(x => { const bounds = x.getBoundingClientRect(); return { client: x.clientWidth, scroll: x.scrollWidth, rows: Array.from(x.querySelectorAll("tbody tr")).map(row => { const repo = row.querySelector("a.repo-name")!, rect = repo.getBoundingClientRect(); return { repository: repo.textContent, repositoryFits: rect.left >= bounds.left - 1 && rect.right <= bounds.right + 1, timestamp: row.querySelector(".repo-meta")?.textContent }; }) }; }); assert(auditWidth.rows.length > 0); for (const row of auditWidth.rows) { assert(row.repository && row.repositoryFits, "Compact activity repository name is visible within its column"); assert(/\d{4}-\d{2}-\d{2}/.test(row.timestamp || ""), "Compact activity timestamp remains rendered beneath actor/source"); } assert(auditWidth.scroll <= auditWidth.client + 1, `Scoped compact activity table fits its column: ${JSON.stringify(auditWidth)}`); auditGeometry = auditWidth; }
    const tag = `${key}-${lang}-${mobile ? "mobile" : "desktop"}-${theme}`;
    await screenshot(tag + ".png");
    if (count === 2 && key === "global" && !mobile && ["en", "zh"].includes(lang) && theme !== "auto") {
     await page.setViewportSize({ width: 1440, height: 900 }); await page.screenshot({ path: resolve(out, tag + "-viewport.png"), fullPage: false }); await page.setViewportSize({ width: 1440, height: 1000 });
    }
    if (["en", "zh"].includes(lang) && !mobile && ["global", "account", "settings"].includes(key) && theme !== "auto") console.log(JSON.stringify({ reviewImage: resolve(out, tag + ".png") }));
    if ((key === "global" && count > 0) || ((key === "installations" || (focused && key === "account")) && count === 2)) { await page.locator("[data-account-picker] summary").click(); await screenshot(tag + "-accounts.png"); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "Open account popup overflow"); await page.keyboard.press("Escape"); }
    if (mobile) { await page.locator("[data-menu-button]").click(); await page.evaluate(async () => { await Promise.all(document.getAnimations().map(animation => animation.finished.catch(() => {}))); }); if (path === "/admin/installations" || (focused && key === "account")) await screenshot(tag + "-navigation.png"); await page.keyboard.press("Tab"); assert.equal(await page.evaluate(() => document.getElementById("admin-sidebar")?.contains(document.activeElement)), true); await page.keyboard.press("Shift+Tab"); assert.equal(await page.evaluate(() => document.getElementById("admin-sidebar")?.contains(document.activeElement)), true); await page.keyboard.press("Escape"); assert.equal(await page.locator("[data-menu-button]").getAttribute("aria-expanded"), "false"); assert.equal(await page.locator("[data-menu-button]").evaluate(x => x === document.activeElement), true); }
    matrix.push({ key, path, scoped, lang, mobile, theme, audit: auditGeometry });
    if (matrix.length % 18 === 0) console.log(JSON.stringify({ progress: matrix.length, fixture: count, lang, mobile }));
   }
  }
 }
 assert.deepEqual(errors, []);
} catch (error) {
 errors.push(error instanceof Error ? error.message : String(error));
 await screenshot("failure.png").catch(() => {});
 throw error;
} finally {
 await browser.close();
 const finalHealth = await (await fetch(base + "/__preview/health")).json();
 await writeFile(resolve(out, "results.json"), JSON.stringify({ at: new Date().toISOString(), health, checks, matrix, pageshows, errors, finalHealth }, null, 2) + "\n");
 assert.equal(finalHealth.decisionCalls, health.decisionCalls, "No paid model calls during QA");
 console.log(JSON.stringify({ checks: checks.length, screenshots: matrix.length, errors: errors.length, modelCalls: finalHealth.decisionCalls, fixture: health.installationCount }));
}

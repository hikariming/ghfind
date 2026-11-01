// Browser regression for the actual mobile drawer. Run the local dashboard first:
// pnpm exec tsx platform/github-app/scripts/check-dashboard-menu.mts
// --source tests current JS/CSS against existing SSR HTML before rebuild.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium } from "playwright";
import { ADMIN_SCRIPT } from "../src/admin-script.ts";
import { ADMIN_STYLE } from "../src/admin-style.ts";

const base = process.env.DASHBOARD_PREVIEW_URL || "http://127.0.0.1:4201";
const output = process.env.DASHBOARD_MENU_OUTPUT || "/tmp/ghfind-dashboard-menu";
const sourceOverride = process.argv.includes("--source");
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
const results: { locale: string; theme: string; checks: string[] }[] = [];
try {
  for (const locale of ["en", "zh", "ar"]) for (const theme of ["light", "dark", "auto"]) {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, colorScheme: "dark" });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    if (sourceOverride) {
      await page.route("**/admin.js", (route) => route.fulfill({ contentType: "text/javascript", body: ADMIN_SCRIPT }));
      await page.route("**/admin?**", async (route) => {
        const response = await route.fetch();
        const body = (await response.text()).replace("</style>", ADMIN_STYLE + "</style>");
        await route.fulfill({ response, body });
      });
    }
    const response = await page.goto(`${base}/admin?installation_id=10&lang=${locale}`);
    assert.equal(response?.status(), 200);
    await page.locator(`[data-theme-choice=${theme}]`).click();
    await page.locator("[data-menu-button]").click();
    assert.equal(await page.locator("[data-menu-button]").getAttribute("aria-expanded"), "true");
    // This immediate keypress reproduces the original BODY-focus failure.
    await page.keyboard.press("Tab");
    const inside = () => page.evaluate(() => document.getElementById("admin-sidebar")!.contains(document.activeElement));
    assert.equal(await inside(), true, `${locale}/${theme}: immediate Tab escaped the drawer`);
    for (const key of ["Tab", "Shift+Tab"]) for (let i = 0; i < 20; i++) {
      await page.keyboard.press(key);
      assert.equal(await inside(), true, `${locale}/${theme}: ${key} escaped the drawer`);
    }
    // Recover when browser focus starts outside the drawer (e.g. transition/blur).
    for (const key of ["Tab", "Shift+Tab"]) {
      await page.evaluate(() => (document.activeElement as HTMLElement).blur());
      await page.keyboard.press(key);
      assert.equal(await inside(), true, `${locale}/${theme}: ${key} did not recover outside focus`);
    }
    assert.equal(await page.locator("#admin-sidebar").getAttribute("aria-modal"), "true");
    assert.equal(await page.evaluate(() => (document.querySelector(".admin-workspace") as HTMLElement).inert), true);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.locator("#admin-sidebar").evaluate(async (element) => {
      await Promise.allSettled(element.getAnimations().map((animation) => animation.finished));
    });
    const drawer = await page.locator("#admin-sidebar").boundingBox();
    assert(drawer && drawer.x >= -1 && drawer.x + drawer.width <= 391, `${locale}/${theme}: drawer is outside the viewport`);
    await page.screenshot({ path: `${output}/menu-${locale}-${theme}.png` });
    await page.keyboard.press("Escape");
    assert.equal(await page.locator("[data-menu-button]").getAttribute("aria-expanded"), "false");
    assert.equal(await page.evaluate(() => document.activeElement!.matches("[data-menu-button]")), true);
    assert.equal(await page.evaluate(() => (document.querySelector(".admin-workspace") as HTMLElement).inert), false);
    assert.equal(await page.evaluate(() => document.body.style.overflow), "");
    await page.locator("[data-menu-button]").click();
    await page.waitForFunction(() => document.activeElement!.matches("[data-menu-close]"));
    await page.locator("[data-menu-close]").click();
    assert.equal(await page.evaluate(() => document.activeElement!.matches("[data-menu-button]")), true);
    assert.deepEqual(errors, []);
    results.push({ locale, theme, checks: ["immediate Tab", "40 forward/reverse tabs", "outside focus recovery", "Escape return", "painted initial focus", "close button return", "inert background", "no overflow", "no script errors"] });
    await page.close();
  }
  await writeFile(`${output}/results.json`, JSON.stringify({ sourceOverride, base, results }, null, 2));
  console.log(JSON.stringify({ passed: results.length, sourceOverride, output }));
} finally {
  await browser.close();
}

/**
 * Inline <head> script that sets `lang`, `dir`, and the resolved theme on
 * <html> before first paint, so neither the saved theme nor the locale flashes.
 * Shared by the Next root layout and the Astro base layout; the storage key and
 * data attributes are what ThemeToggle reads and writes.
 */
export const THEME_INIT_SCRIPT = `
try {
  var seg = window.location.pathname.split("/")[1];
  var langs = { en: "en", ja: "ja", ko: "ko", es: "es", pt: "pt-BR", id: "id", vi: "vi", ar: "ar" };
  document.documentElement.lang = langs[seg] || "zh-CN";
  document.documentElement.dir = seg === "ar" ? "rtl" : "ltr";

  var key = "github-roast-theme";
  var stored = null;
  try { stored = localStorage.getItem(key); } catch (_) {}
  var isAdvx =
    window.location.pathname.split("/").indexOf("advx") !== -1 ||
    new URLSearchParams(window.location.search).get("campaign") === "advx";
  if (isAdvx) {
    stored = "dark";
    try { localStorage.setItem(key, stored); } catch (_) {}
  }
  var mode = stored === "light" || stored === "dark" || stored === "auto"
    ? stored
    : "auto";
  var theme = mode === "auto"
    ? (window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark")
    : mode;
  document.documentElement.dataset.theme = theme;
  document.documentElement.dataset.themeMode = mode;
  document.documentElement.style.colorScheme = theme;
} catch (_) {}
`;

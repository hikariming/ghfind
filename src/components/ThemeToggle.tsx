"use client";

import { useEffect, useSyncExternalStore } from "react";
import { useTranslations } from "next-intl";

type ThemeMode = "light" | "dark" | "auto";
type ResolvedTheme = "light" | "dark";

const STORAGE_KEY = "github-roast-theme";
const CHANGE_EVENT = "github-roast-theme-change";
const MODES: ThemeMode[] = ["light", "dark", "auto"];

function normalizeMode(value: string | null): ThemeMode {
  return value === "light" || value === "dark" || value === "auto" ? value : "auto";
}

function systemTheme(): ResolvedTheme {
  if (typeof window === "undefined") return "dark";
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

function readMode(): ThemeMode {
  if (typeof window === "undefined") return "auto";
  return normalizeMode(window.localStorage.getItem(STORAGE_KEY));
}

function resolveMode(mode: ThemeMode): ResolvedTheme {
  return mode === "auto" ? systemTheme() : mode;
}

function applyMode(mode: ThemeMode) {
  const theme = resolveMode(mode);
  document.documentElement.dataset.theme = theme;
  document.documentElement.dataset.themeMode = mode;
  document.documentElement.style.colorScheme = theme;
}

function getSnapshot(): string {
  const mode = readMode();
  return `${mode}:${resolveMode(mode)}`;
}

function getServerSnapshot(): string {
  return "auto:dark";
}

function subscribe(onStoreChange: () => void): () => void {
  if (typeof window === "undefined") return () => {};

  const media = window.matchMedia("(prefers-color-scheme: light)");
  const notify = () => {
    applyMode(readMode());
    onStoreChange();
  };

  window.addEventListener(CHANGE_EVENT, notify);
  window.addEventListener("storage", notify);
  media.addEventListener("change", notify);
  return () => {
    window.removeEventListener(CHANGE_EVENT, notify);
    window.removeEventListener("storage", notify);
    media.removeEventListener("change", notify);
  };
}

function setMode(mode: ThemeMode) {
  window.localStorage.setItem(STORAGE_KEY, mode);
  applyMode(mode);
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

export function ThemeToggle() {
  const t = useTranslations("themeSwitch");
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const [mode] = snapshot.split(":") as [ThemeMode, ResolvedTheme];

  // Locale transitions can replace <html> attrs; keep the persisted theme applied.
  useEffect(() => {
    applyMode(mode);
  });

  return (
    <div
      className="inline-flex h-8 items-center rounded-full border border-white/10 bg-white/5 p-0.5 text-xs"
      role="group"
      aria-label={t("label")}
    >
      {MODES.map((m) => {
        const active = mode === m;
        const icon = m === "light" ? "☀" : m === "dark" ? "☾" : "A";
        return (
          <button
            key={m}
            type="button"
            aria-pressed={active}
            aria-label={t(m)}
            title={t(m)}
            onClick={() => setMode(m)}
            className={`flex h-7 w-7 items-center justify-center rounded-full transition-colors ${
              active
                ? "bg-orange-600 text-white shadow-sm"
                : "text-zinc-400 hover:bg-white/10 hover:text-zinc-200"
            }`}
          >
            <span aria-hidden="true" className="text-[13px] font-black leading-none">
              {icon}
            </span>
          </button>
        );
      })}
    </div>
  );
}

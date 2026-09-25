"use client";

import { useSyncExternalStore } from "react";
import { useTranslations } from "next-intl";
import { Monitor, Moon, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useMountEffect } from "@/lib/use-mount-effect";

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
  const [mode, resolved] = snapshot.split(":") as [ThemeMode, ResolvedTheme];

  // Locale transitions can replace <html> attrs; keep the persisted theme applied.
  useMountEffect(() => {
    applyMode(mode);
  });

  const nextMode = MODES[(MODES.indexOf(mode) + 1) % MODES.length];
  const icon = mode === "auto" ? <Monitor className="h-4 w-4" /> : resolved === "light" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />;

  return (
    <Button
      type="button"
      aria-label={`${t("label")}: ${t(mode)}`}
      aria-description={`${t("label")}: ${t(nextMode)}`}
      title={`${t("label")}: ${t(mode)}`}
      onClick={() => setMode(nextMode)}
      variant="ghost"
      size="icon"
      className="theme-toggle h-8 w-8 text-zinc-500 hover:bg-[var(--surface-muted)] hover:text-[var(--foreground)]"
    >
      {icon}
    </Button>
  );
}

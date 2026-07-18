"use client";

import { signIn } from "next-auth/react";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { fetchMe } from "@/lib/me-client";

/** localStorage key remembering that the user dismissed (or used) the nudge. */
const DISMISS_KEY = "gh-roast-login-nudge";
/** Re-show the nudge only after this long since the last dismissal. */
const SNOOZE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
/** Wait a beat after load so the card slides in, instead of greeting on arrival. */
const SHOW_DELAY_MS = 4000;
/** Matches the slide-out transition duration before we unmount. */
const EXIT_MS = 300;

/**
 * Subtle GitHub-login nudge for signed-out visitors. Mounted from the layout
 * only when OAuth is configured and there is no session, so this component never
 * has to know about auth — it just owns the timing, the slide animation, and the
 * "don't nag me again" snooze. Sits at the top-right (just under the sticky
 * navbar) on desktop, full-width under the navbar on mobile, sliding down into
 * view. The outer card has a dedicated theme hook so its translucent panel can
 * stay dark in dark mode and become a real light surface in light mode.
 *
 * Sign-in runs client-side via `next-auth/react`'s `signIn("github")`. Visibility
 * is self-contained: `configured` gates OAuth availability, and we probe `/api/me`
 * so the nudge never shows to an already-signed-in visitor — the layout no longer
 * reads the session server-side (that would opt every page out of CDN caching).
 */
export function LoginNudge({ configured }: { configured: boolean }) {
  const t = useTranslations("loginNudge");
  const [mounted, setMounted] = useState(false);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!configured) return;
    try {
      const raw = localStorage.getItem(DISMISS_KEY);
      if (raw) {
        const ts = Number(raw);
        if (Number.isFinite(ts) && Date.now() - ts < SNOOZE_MS) return;
      }
    } catch {
      // localStorage unavailable (private mode etc.) — just show the nudge.
    }
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Only nudge signed-out visitors; skip the prompt once a session exists.
    // fetchMe shares the navbar's probe (one /api/me per pageview) and resolves
    // signed-out on failure — signed-out is the norm, so we nudge either way.
    fetchMe().then((d) => {
      if (!alive || d.user) return;
      timer = setTimeout(() => {
        setMounted(true);
        // Two frames so the initial (hidden) styles paint before we flip to visible.
        requestAnimationFrame(() => requestAnimationFrame(() => setVisible(true)));
      }, SHOW_DELAY_MS);
    });
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [configured]);

  const dismiss = () => {
    try {
      localStorage.setItem(DISMISS_KEY, String(Date.now()));
    } catch {
      // ignore — worst case the nudge reappears next visit.
    }
    setVisible(false);
    setTimeout(() => setMounted(false), EXIT_MS);
  };

  if (!mounted) return null;

  return (
    <div
      role="dialog"
      aria-label={t("title")}
      className={`fixed inset-x-3 top-[4.5rem] z-50 sm:inset-x-auto sm:start-auto sm:end-4 sm:top-[4.5rem] sm:w-[26rem] transition-all duration-300 ease-out ${
        visible ? "translate-y-0 opacity-100" : "-translate-y-6 opacity-0"
      }`}
    >
      <div className="login-nudge-card relative rounded-2xl border border-orange-400/25 bg-zinc-900/95 p-5 shadow-2xl ring-1 ring-orange-500/10 backdrop-blur">
        <button
          type="button"
          onClick={dismiss}
          aria-label={t("close")}
          className="absolute end-3 top-3 rounded-full p-1 text-zinc-500 hover:bg-white/10 hover:text-zinc-300"
        >
          <svg viewBox="0 0 16 16" aria-hidden className="h-5 w-5 fill-current">
            <path d="M4.3 4.3a1 1 0 0 1 1.4 0L8 6.6l2.3-2.3a1 1 0 1 1 1.4 1.4L9.4 8l2.3 2.3a1 1 0 0 1-1.4 1.4L8 9.4l-2.3 2.3a1 1 0 0 1-1.4-1.4L6.6 8 4.3 5.7a1 1 0 0 1 0-1.4Z" />
          </svg>
        </button>

        <h3 className="pe-7 text-lg font-bold text-zinc-100">{t("title")}</h3>
        <p className="mt-1.5 text-sm leading-relaxed text-zinc-400">{t("body")}</p>

        <div className="mt-4 flex items-center gap-3">
          <button
            type="button"
            onClick={() => signIn("github")}
            className="inline-flex items-center gap-2 rounded-full bg-orange-600 px-4 py-2 text-sm font-semibold text-white hover:bg-orange-500"
          >
            <svg viewBox="0 0 16 16" aria-hidden className="h-[18px] w-[18px] fill-current">
              <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
            </svg>
            {t("signIn")}
          </button>
          <button
            type="button"
            onClick={dismiss}
            className="text-xs text-zinc-500 hover:text-zinc-300"
          >
            {t("dismiss")}
          </button>
        </div>
      </div>
    </div>
  );
}

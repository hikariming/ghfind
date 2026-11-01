"use client";

import { useEffect, useRef } from "react";

declare global {
  interface Window {
    turnstile?: {
      render: (
        el: HTMLElement,
        opts: {
          sitekey: string;
          callback: (token: string) => void;
          "expired-callback"?: () => void;
          theme?: "dark" | "light" | "auto";
          size?: "normal" | "flexible" | "compact";
        },
      ) => string;
      reset: (id?: string) => void;
    };
  }
}

/**
 * Next inlines `process.env.NEXT_PUBLIC_*` at build time; other bundlers (the
 * Astro islands) leave `process` undefined in the browser, where reading it
 * throws. There the widget simply counts as not configured.
 */
function turnstileSiteKey(): string | undefined {
  try {
    return process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;
  } catch {
    return undefined;
  }
}

const SCRIPT_SRC =
  "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

/**
 * Cloudflare Turnstile widget. Renders nothing (and reports an empty token) when
 * no site key is configured, so local dev works without Cloudflare.
 */
export function Turnstile({ onToken }: { onToken: (token: string) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const siteKey = turnstileSiteKey();

  useEffect(() => {
    if (!siteKey || !ref.current) return;

    const tryRender = () => {
      if (!window.turnstile || !ref.current) return false;
      window.turnstile.render(ref.current, {
        sitekey: siteKey,
        theme: "dark",
        size: "flexible",
        callback: (token) => onToken(token),
        "expired-callback": () => onToken(""),
      });
      return true;
    };

    if (!tryRender()) {
      if (!document.querySelector(`script[src="${SCRIPT_SRC}"]`)) {
        const s = document.createElement("script");
        s.src = SCRIPT_SRC;
        s.async = true;
        document.head.appendChild(s);
      }
      const iv = setInterval(() => {
        if (tryRender()) clearInterval(iv);
      }, 200);
      return () => clearInterval(iv);
    }
  }, [siteKey, onToken]);

  if (!siteKey) return null;
  return <div ref={ref} className="my-2" />;
}

export const turnstileEnabled = (): boolean => Boolean(turnstileSiteKey());

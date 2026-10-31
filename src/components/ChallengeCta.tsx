"use client";

import { useCallback, useRef, useState } from "react";
import { useRouter } from "@/i18n/navigation";
import { normalizeUsername } from "@/lib/username";
import { trackEvent, type PkSource } from "@/lib/track";

interface MeResponse {
  user: { login: string; image: string | null } | null;
  scored: boolean;
}

/**
 * Shared "challenge this dev to a PK" control, powering the badge-landing banner,
 * the profile Challenge button, and (potentially) other in-page entry points.
 *
 * Click flow: probe {@link /api/me} once (cached in a ref). A signed-in visitor
 * duels straight away — we canonicalize the pair client-side (lowercase +
 * dictionary order) so the pushed slug matches the /vs page's own redirect and
 * skips the server 301. An anonymous visitor expands an inline handle input
 * instead. Either way the unscored side is summoned on the /vs page itself
 * (VsSummonButton), so no backend work happens here.
 */
export function ChallengeCta({
  opponent,
  source,
  variant = "button",
  label,
  goLabel,
  placeholder,
  selfHint,
  invalidHint,
  className,
}: {
  /** The profile owner — side A of the duel. */
  opponent: string;
  source: PkSource;
  variant?: "button" | "banner";
  /** CTA button copy (localized by the parent, which owns the namespace). */
  label: string;
  /** Submit-button copy shown once the anonymous input is expanded. */
  goLabel: string;
  placeholder: string;
  /** Shown when the visitor tries to duel themselves. */
  selfHint: string;
  /** Shown when the typed handle isn't a valid GitHub login. */
  invalidHint: string;
  className?: string;
}) {
  const router = useRouter();
  const [expanded, setExpanded] = useState(false);
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const meRef = useRef<MeResponse | null>(null);

  const oppLower = opponent.toLowerCase();

  const duel = useCallback(
    (meHandle: string, mode: "direct" | "input") => {
      const meLower = meHandle.toLowerCase();
      if (meLower === oppLower) {
        setError(selfHint);
        setExpanded(true);
        return;
      }
      trackEvent("pk_cta_click", { source, opponent: oppLower, mode });
      if (source === "badge_banner") {
        trackEvent("badge_banner_click", { opponent: oppLower });
      }
      const [x, y] = [oppLower, meLower].sort();
      router.push(`/vs/${x}/${y}`);
    },
    [oppLower, selfHint, source, router],
  );

  const onPrimaryClick = useCallback(async () => {
    if (busy) return;
    setError(null);
    if (meRef.current === null) {
      setBusy(true);
      try {
        const res = await fetch("/api/me");
        meRef.current = res.ok
          ? ((await res.json()) as MeResponse)
          : { user: null, scored: false };
      } catch {
        meRef.current = { user: null, scored: false };
      }
      setBusy(false);
    }
    const login = meRef.current?.user?.login;
    if (login) {
      duel(login, "direct");
      return;
    }
    setExpanded(true);
  }, [busy, duel]);

  const submitInput = useCallback(() => {
    const n = normalizeUsername(value);
    if (!n) {
      setError(invalidHint);
      return;
    }
    duel(n, "input");
  }, [value, invalidHint, duel]);

  const full = variant === "banner";

  if (expanded) {
    return (
      <div className={className}>
        <div className={`flex items-center gap-2 ${full ? "w-full" : ""}`}>
          <div className="challenge-field group flex flex-1 items-center gap-2 rounded-full border border-white/15 bg-black/25 px-3 py-1.5 transition focus-within:border-orange-500/60">
            <span className="select-none text-sm font-semibold text-zinc-500 group-focus-within:text-orange-400">
              @
            </span>
            <input
              value={value}
              autoFocus
              onChange={(e) => {
                setValue(e.target.value);
                if (error) setError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  submitInput();
                }
              }}
              placeholder={placeholder}
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              className="w-full min-w-0 bg-transparent text-sm text-zinc-100 outline-none placeholder:text-zinc-600"
            />
          </div>
          <button
            type="button"
            onClick={submitInput}
            className="shrink-0 rounded-full bg-orange-600 px-4 py-1.5 text-sm font-semibold text-white transition hover:bg-orange-500"
          >
            {goLabel}
          </button>
        </div>
        {error && <p className="mt-1.5 text-xs text-rose-300">{error}</p>}
      </div>
    );
  }

  return (
    <div className={className}>
      <button
        type="button"
        onClick={onPrimaryClick}
        disabled={busy}
        className={`inline-flex items-center justify-center gap-1.5 rounded-full bg-orange-600 font-semibold text-white transition hover:bg-orange-500 disabled:cursor-not-allowed disabled:opacity-60 ${
          full ? "w-full px-5 py-2.5 text-sm" : "px-4 py-2 text-sm"
        }`}
      >
        <span aria-hidden>⚔️</span>
        {label}
      </button>
      {error && <p className="mt-1.5 text-xs text-rose-300">{error}</p>}
    </div>
  );
}

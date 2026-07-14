"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { signIn } from "next-auth/react";
import { Link } from "@/i18n/navigation";
import { tierStyle } from "@/lib/tier";
import type { Tier } from "@/lib/types";

interface FollowedAccount {
  username: string;
  display_name: string | null;
  avatar_url: string | null;
  final_score: number | null;
  tier: Tier | null;
  weekly_delta: number | null;
}

interface MeResponse {
  user: { login: string; image: string | null } | null;
}

type Status = "loading" | "signedOut" | "ready";

/**
 * Full-page version of the "accounts you follow + their weekly score moves"
 * board. Moved off the homepage into its own secondary page (reached from the
 * avatar menu). A client island so the page shell stays static: it probes
 * `/api/me`, and only then pulls `/api/follows`. Anonymous visitors get a
 * sign-in nudge instead of the empty render the homepage module used.
 */
export function FollowingBoard() {
  const t = useTranslations("follow");
  const [accounts, setAccounts] = useState<FollowedAccount[] | null>(null);
  const [status, setStatus] = useState<Status>("loading");

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const meRes = await fetch("/api/me");
        const me = meRes.ok ? ((await meRes.json()) as MeResponse) : null;
        if (!alive) return;
        if (!me?.user) {
          setStatus("signedOut");
          return;
        }
        const res = await fetch("/api/follows");
        if (!alive) return;
        if (!res.ok) {
          setAccounts([]);
          setStatus("ready");
          return;
        }
        const data = (await res.json()) as { accounts: FollowedAccount[] | null };
        setAccounts(Array.isArray(data.accounts) ? data.accounts : []);
        setStatus("ready");
      } catch {
        if (alive) {
          setAccounts([]);
          setStatus("ready");
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  if (status === "signedOut") {
    return (
      <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-8 text-center">
        <h2 className="text-lg font-bold text-zinc-100">{t("signInTitle")}</h2>
        <p className="mx-auto mt-2 max-w-sm text-sm text-zinc-400">{t("signInBody")}</p>
        <button
          type="button"
          onClick={() => signIn("github")}
          className="mt-5 inline-flex h-10 items-center gap-2 rounded-full border border-white/10 bg-white/[0.03] px-4 text-sm font-medium text-zinc-200 shadow-sm transition-colors hover:bg-white/[0.06] hover:text-white"
        >
          <svg viewBox="0 0 16 16" aria-hidden className="h-4 w-4 fill-current">
            <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
          </svg>
          {t("signIn")}
        </button>
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-5">
      {status === "loading" || accounts === null ? (
        <div className="space-y-2">
          <div className="h-12 animate-pulse rounded-xl bg-white/5" />
          <div className="h-12 animate-pulse rounded-xl bg-white/5" />
          <div className="h-12 animate-pulse rounded-xl bg-white/5" />
        </div>
      ) : accounts.length === 0 ? (
        <p className="py-6 text-center text-sm text-zinc-400">{t("homeEmpty")}</p>
      ) : (
        <ul className="divide-y divide-white/5">
          {accounts.map((a) => {
            const style = a.tier ? tierStyle(a.tier) : null;
            const delta = a.weekly_delta;
            return (
              <li key={a.username}>
                <Link
                  href={`/u/${a.username}`}
                  className="flex items-center gap-3 rounded-lg px-1 py-2.5 transition hover:bg-white/5"
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={a.avatar_url ?? `https://github.com/${a.username}.png?size=64`}
                    alt=""
                    width={28}
                    height={28}
                    loading="lazy"
                    className="h-7 w-7 rounded-full bg-white/10"
                  />
                  <span className="min-w-0 flex-1 truncate text-sm font-semibold text-zinc-200">
                    @{a.username}
                  </span>
                  {a.final_score !== null && style ? (
                    <>
                      <span className={`text-sm font-bold tabular-nums ${style.text}`}>
                        {style.emoji} {a.final_score.toFixed(2)}
                      </span>
                      {delta !== null ? (
                        <span
                          className={`w-14 text-end text-xs font-bold tabular-nums ${
                            delta > 0 ? "text-emerald-300" : "text-rose-300"
                          }`}
                        >
                          {delta > 0 ? "↑" : "↓"}
                          {Math.abs(delta).toFixed(1)}
                        </span>
                      ) : (
                        <span className="w-14 text-end text-xs text-zinc-600">—</span>
                      )}
                    </>
                  ) : (
                    <span className="text-xs text-zinc-500">{t("unrated")}</span>
                  )}
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

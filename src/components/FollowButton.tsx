"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { signInWithGitHub } from "@/lib/oauth-client";

type FollowState = "loading" | "anon" | "following" | "not_following";

/**
 * Follow/unfollow toggle on a profile page. Probes follow state on mount
 * (the GET stays quiet — plain `signedIn:false` — for anonymous visitors);
 * an anonymous click routes into GitHub sign-in instead, so the button doubles
 * as a conversion point. Followed handles feed the "我关注的人" board on the
 * /following page (reached from the avatar menu) — the "reason to come back" loop.
 */
export function FollowButton({
  username,
  className,
}: {
  username: string;
  className?: string;
}) {
  const t = useTranslations("follow");
  const [state, setState] = useState<FollowState>("loading");
  const [busy, setBusy] = useState(false);
  const [hint, setHint] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetch(`/api/follows/${encodeURIComponent(username)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { following?: boolean; signedIn?: boolean } | null) => {
        if (!alive) return;
        if (!d?.signedIn) setState("anon");
        else setState(d.following ? "following" : "not_following");
      })
      .catch(() => {
        if (alive) setState("anon");
      });
    return () => {
      alive = false;
    };
  }, [username]);

  const toggle = async () => {
    if (busy || state === "loading") return;
    setHint(null);
    if (state === "anon") {
      signInWithGitHub();
      return;
    }
    setBusy(true);
    const wasFollowing = state === "following";
    try {
      const res = await fetch(`/api/follows/${encodeURIComponent(username)}`, {
        method: wasFollowing ? "DELETE" : "PUT",
      });
      if (res.ok) {
        setState(wasFollowing ? "not_following" : "following");
      } else if (res.status === 401) {
        signInWithGitHub();
      } else if (res.status === 409) {
        setHint(t("limit"));
      }
    } catch {
      // network hiccup — leave the state as-is; the next click retries
    } finally {
      setBusy(false);
    }
  };

  const following = state === "following";
  return (
    <div className={className}>
      <button
        type="button"
        onClick={toggle}
        disabled={busy || state === "loading"}
        aria-pressed={following}
        className={`inline-flex w-full items-center justify-center gap-1.5 rounded-full border px-4 py-2 text-sm font-semibold transition disabled:cursor-not-allowed disabled:opacity-60 ${
          following
            ? "border-emerald-400/40 text-emerald-200 hover:bg-emerald-500/10"
            : "border-white/15 text-zinc-200 hover:bg-white/10"
        }`}
      >
        <span aria-hidden>{following ? "✓" : "👀"}</span>
        {following ? t("following") : t("button")}
      </button>
      {hint && <p className="mt-1.5 text-xs text-rose-300">{hint}</p>}
    </div>
  );
}

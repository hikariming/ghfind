"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import {
  applyReactionSelection,
  PROFILE_REACTIONS,
  type ProfileReaction,
  type ProfileReactionState,
} from "@/lib/reactions";

const REACTION_EMOJI: Record<ProfileReaction, string> = {
  like: "👍",
  poop: "💩",
  kick: "🦶",
  fire: "🔥",
  salute: "🫡",
  clown: "🤡",
};

export function ProfileReactions({
  authenticated,
  authAvailable,
  initialState,
  profileUsername,
  signInAction,
}: {
  authenticated: boolean;
  authAvailable: boolean;
  initialState: ProfileReactionState;
  profileUsername: string;
  signInAction: () => Promise<void>;
}) {
  const t = useTranslations("reactions");
  const [state, setState] = useState(initialState);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const [showLogin, setShowLogin] = useState(false);
  const [animated, setAnimated] = useState<ProfileReaction | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const pickerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!pickerOpen) return;
    function onPointerDown(event: MouseEvent) {
      if (pickerRef.current && !pickerRef.current.contains(event.target as Node)) {
        setPickerOpen(false);
      }
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setPickerOpen(false);
    }
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [pickerOpen]);

  async function react(reaction: ProfileReaction) {
    setPickerOpen(false);
    if (!authenticated) {
      setShowLogin(true);
      setFailed(false);
      return;
    }
    if (saving) return;

    const previousState = state;
    const nextReaction = state.viewerReaction === reaction ? null : reaction;
    setState({
      counts: applyReactionSelection(state.counts, state.viewerReaction, nextReaction),
      viewerReaction: nextReaction,
    });
    setSaving(true);
    setFailed(false);
    setAnimated(reaction);

    try {
      const response = await fetch(
        `/api/profile-reactions/${encodeURIComponent(profileUsername)}`,
        {
          method: nextReaction ? "PUT" : "DELETE",
          headers: nextReaction ? { "Content-Type": "application/json" } : undefined,
          body: nextReaction ? JSON.stringify({ reaction: nextReaction }) : undefined,
        },
      );
      if (response.status === 401) {
        setShowLogin(true);
        throw new Error("authentication_required");
      }
      if (!response.ok) throw new Error("reaction_failed");
      setState((await response.json()) as ProfileReactionState);
    } catch (error) {
      setState(previousState);
      setFailed(
        !(error instanceof Error && error.message === "authentication_required"),
      );
    } finally {
      setSaving(false);
    }
  }

  const activeReactions = PROFILE_REACTIONS.filter(
    (reaction) => state.counts[reaction] > 0,
  );

  return (
    <section className="mt-4 rounded-2xl border border-orange-300/15 bg-orange-500/[0.035] p-3 sm:p-4">
      <div className="mb-2.5 flex flex-col gap-0.5 sm:flex-row sm:items-baseline sm:justify-between sm:gap-4">
        <h2 className="text-sm font-bold text-orange-100">{t("heading")}</h2>
        <p className="text-[11px] text-zinc-500">{t("hint")}</p>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        {activeReactions.map((reaction) => {
          const selected = state.viewerReaction === reaction;
          const count = state.counts[reaction];
          return (
            <button
              key={reaction}
              type="button"
              title={t(reaction)}
              aria-label={`${t(reaction)}: ${count}`}
              aria-pressed={selected}
              disabled={saving}
              onClick={() => react(reaction)}
              onAnimationEnd={() => {
                if (animated === reaction) setAnimated(null);
              }}
              className={`profile-reaction-button inline-flex items-center gap-1 rounded-full border px-2 py-0.5 transition-colors disabled:cursor-wait ${
                selected
                  ? "border-orange-400/60 bg-orange-500/15 text-orange-100"
                  : "border-white/10 bg-black/20 text-zinc-300 hover:border-orange-300/30 hover:bg-orange-500/[0.07]"
              } ${animated === reaction ? "profile-reaction-bump" : ""}`}
            >
              <span aria-hidden="true" className="text-base leading-none">
                {REACTION_EMOJI[reaction]}
              </span>
              <span className="text-xs font-bold tabular-nums">{count}</span>
            </button>
          );
        })}

        <div ref={pickerRef} className="relative">
          <button
            type="button"
            aria-label={t("addReaction")}
            aria-haspopup="true"
            aria-expanded={pickerOpen}
            disabled={saving}
            onClick={() => {
              if (!authenticated) {
                setShowLogin(true);
                setFailed(false);
                return;
              }
              setPickerOpen((open) => !open);
            }}
            className="inline-flex h-7 items-center gap-1 rounded-full border border-white/10 bg-black/20 px-2 text-zinc-400 transition-colors hover:border-orange-300/30 hover:bg-orange-500/[0.07] hover:text-orange-100 disabled:cursor-wait"
          >
            <span aria-hidden="true" className="text-base leading-none">
              🙂
            </span>
            <span aria-hidden="true" className="text-sm font-bold leading-none">
              +
            </span>
          </button>

          {pickerOpen ? (
            <div
              role="menu"
              className="absolute left-0 top-full z-10 mt-1.5 flex items-center gap-1 rounded-full border border-white/10 bg-zinc-900/95 px-2 py-1.5 shadow-xl shadow-black/40 backdrop-blur"
            >
              {PROFILE_REACTIONS.map((reaction) => {
                const selected = state.viewerReaction === reaction;
                return (
                  <button
                    key={reaction}
                    type="button"
                    role="menuitemradio"
                    title={t(reaction)}
                    aria-label={t(reaction)}
                    aria-checked={selected}
                    onClick={() => react(reaction)}
                    className={`flex h-8 w-8 items-center justify-center rounded-full text-lg leading-none transition-colors hover:bg-orange-500/15 ${
                      selected ? "bg-orange-500/20 ring-1 ring-orange-400/50" : ""
                    }`}
                  >
                    <span aria-hidden="true">{REACTION_EMOJI[reaction]}</span>
                  </button>
                );
              })}
            </div>
          ) : null}
        </div>
      </div>

      {showLogin && !authenticated ? (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-orange-300/15 bg-black/25 px-3 py-2">
          <p role="status" className="text-xs text-orange-100/80">
            {t("loginRequired")}
          </p>
          {authAvailable ? (
            <form action={signInAction}>
              <button
                type="submit"
                className="rounded-full bg-orange-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-orange-500"
              >
                {t("loginAction")}
              </button>
            </form>
          ) : null}
        </div>
      ) : null}

      {failed ? (
        <p role="alert" className="mt-3 text-xs text-red-300/80">
          {t("failed")}
        </p>
      ) : null}
    </section>
  );
}

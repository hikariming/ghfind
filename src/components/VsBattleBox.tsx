"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "@/i18n/navigation";
import { normalizeUsername } from "@/lib/username";

/**
 * The PK arena on the /vs index: two GitHub handles → a head-to-head duel.
 * Normalizes + canonicalizes (lowercase, dictionary order) both handles so the
 * pushed slug matches what the matchup page would redirect to — no round-trip.
 */
export function VsBattleBox() {
  const t = useTranslations("vs");
  const router = useRouter();
  const [a, setA] = useState("");
  const [b, setB] = useState("");
  const [error, setError] = useState(false);

  const fight = () => {
    const na = normalizeUsername(a);
    const nb = normalizeUsername(b);
    if (!na || !nb || na.toLowerCase() === nb.toLowerCase()) {
      setError(true);
      return;
    }
    const [x, y] = [na.toLowerCase(), nb.toLowerCase()].sort();
    router.push(`/vs/${x}/${y}`);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      fight();
    }
  };

  const field = (
    value: string,
    setValue: (v: string) => void,
    placeholder: string,
  ) => (
    <div className="group flex flex-1 items-center gap-2 rounded-xl border border-white/10 bg-black/20 px-3 py-2.5 transition focus-within:border-orange-500/60 focus-within:bg-black/30">
      <span className="select-none text-sm font-semibold text-zinc-500 group-focus-within:text-orange-400">
        @
      </span>
      <input
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
          if (error) setError(false);
        }}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        autoComplete="off"
        autoCapitalize="off"
        spellCheck={false}
        className="w-full min-w-0 bg-transparent text-sm text-zinc-100 outline-none placeholder:text-zinc-600"
      />
    </div>
  );

  return (
    <section className="relative overflow-hidden rounded-2xl border border-white/10 bg-gradient-to-br from-orange-500/[0.08] via-white/[0.03] to-rose-500/[0.06] p-5 shadow-lg shadow-black/20 sm:p-6">
      {/* soft glow behind the VS */}
      <div className="pointer-events-none absolute left-1/2 top-1/2 -z-10 h-40 w-40 -translate-x-1/2 -translate-y-1/2 rounded-full bg-orange-500/20 blur-3xl" />

      <div className="text-center">
        <h2 className="text-lg font-black text-zinc-100">{t("pkHeading")}</h2>
        <p className="mt-1 text-xs text-zinc-400">{t("pkSub")}</p>
      </div>

      <div className="mt-5 flex flex-col items-stretch gap-3 sm:flex-row sm:items-center">
        {field(a, setA, t("pkPlaceholderA"))}

        <div className="flex shrink-0 items-center justify-center">
          <span className="text-2xl font-black text-orange-500">VS</span>
        </div>

        {field(b, setB, t("pkPlaceholderB"))}
      </div>

      <button
        type="button"
        onClick={fight}
        className="mt-4 w-full rounded-xl bg-orange-600 px-5 py-3 text-sm font-bold text-white shadow-md shadow-orange-900/30 transition hover:bg-orange-500 active:scale-[0.99]"
      >
        {t("pkButton")}
      </button>

      {error && (
        <p className="mt-3 text-center text-xs text-rose-300">{t("pkInvalid")}</p>
      )}
    </section>
  );
}

"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "@/i18n/navigation";
import {
  type OmniIntent,
  type OmniSuggestion,
  omniboxRoute,
  omniboxSuggestions,
  parseOmnibox,
  shouldAutoLockPkIntent,
} from "@/lib/omnibox";
import type { UserSuggestion } from "@/lib/db";
import { tierStyle } from "@/lib/tier";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

const PLACEHOLDER_COUNT = 4;
const GROUP_ORDER: Record<OmniSuggestion["group"], number> = {
  direct: 0,
  pk: 1,
  user: 2,
  discover: 3,
};

/** Leading glyph that reflects the current intent — the "it heard you" cue. */
function intentIcon(kind: OmniIntent["kind"]): string {
  if (kind === "pk" || kind === "pk-half") return "⚔️";
  if (kind === "language" || kind === "org" || kind === "repo") return "📊";
  if (kind === "freetext") return "🔍";
  return "@";
}

/** A rendered dropdown row (from the pure parser or a DB-backed user match). */
interface Row {
  key: string;
  group: OmniSuggestion["group"];
  icon: string;
  label: string;
  hint?: string;
  /** When set, render the richer scored-user row (avatar + score badge). */
  user?: UserSuggestion;
  activate: () => void;
}

/**
 * The homepage Omnibox: one input that resolves to roast / PK / language / org /
 * search. A bare handle stays an in-place roast (calls `onRoast`, preserving the
 * old behavior); `a vs b` and facet intents navigate. Typing ` vs ` locks the
 * first handle into a chip and switches to entering the opponent.
 *
 * Already-scored handles are fetched from the DB as you type and offered
 * directly (with their score) for both roast and PK.
 *
 * Controlled: the parent owns the text `value` (so the `?username=` prefill keeps
 * working) while this component owns the PK chip state and suggestion panel.
 */
export function Omnibox({
  value,
  onChange,
  onRoast,
  busy,
}: {
  value: string;
  onChange: (next: string) => void;
  onRoast: (username: string) => void;
  busy: boolean;
}) {
  const t = useTranslations("omnibox");
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const suppressNextHalfLockRef = useRef(false);

  // The locked first handle once a PK separator is typed; while set, `value`
  // holds only the opponent's handle and the combined string is reconstructed.
  const [pkA, setPkA] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [phIndex, setPhIndex] = useState(0);
  const [dbUsers, setDbUsers] = useState<UserSuggestion[]>([]);

  // Rotate the placeholder (post-mount only, so SSR/CSR markup matches).
  useEffect(() => {
    const id = setInterval(
      () => setPhIndex((i) => (i + 1) % PLACEHOLDER_COUNT),
      3000,
    );
    return () => clearInterval(id);
  }, []);

  // The full logical string the parser sees (folds in the locked chip).
  const logical = pkA ? `${pkA} vs ${value}` : value;
  const intent = useMemo(() => parseOmnibox(logical), [logical]);
  const suggestions = useMemo(() => omniboxSuggestions(logical), [logical]);

  // Debounced DB autocomplete: search on the handle being typed (the opponent
  // slot while a PK chip is locked, otherwise the whole handle/freetext value).
  const searchToken =
    pkA != null
      ? value
      : intent.kind === "user" || intent.kind === "freetext"
        ? value
        : "";
  useEffect(() => {
    const q = searchToken.trim().replace(/^@/, "");
    const ctrl = new AbortController();
    const id = setTimeout(async () => {
      if (q.length < 1) {
        setDbUsers([]);
        return;
      }
      try {
        const res = await fetch(`/api/search-users?q=${encodeURIComponent(q)}`, {
          signal: ctrl.signal,
        });
        if (!res.ok) return;
        const data = (await res.json()) as { users?: UserSuggestion[] };
        setDbUsers(data.users ?? []);
      } catch {
        /* aborted or offline — keep the last results */
      }
    }, 250);
    return () => {
      clearTimeout(id);
      ctrl.abort();
    };
  }, [searchToken]);

  const ctaLabel =
    intent.kind === "pk" || intent.kind === "pk-half"
      ? t("ctaPk")
      : intent.kind === "language" || intent.kind === "org" || intent.kind === "repo"
        ? t("ctaDiscover")
        : t("ctaJudge");

  // Execute a parsed intent: navigate for facet/PK targets, roast in place for a
  // bare handle, or advance to the opponent slot for a half-typed PK.
  const activateIntent = useCallback(
    (it: OmniIntent) => {
      const route = omniboxRoute(it);
      if (route) {
        setOpen(false);
        router.push(route);
        return;
      }
      if (it.kind === "pk-half") {
        setPkA(it.a);
        onChange("");
        setActiveIndex(-1);
        requestAnimationFrame(() => inputRef.current?.focus());
        return;
      }
      if (it.kind === "user") {
        setOpen(false);
        onRoast(it.username);
      }
    },
    [router, onChange, onRoast],
  );

  const roastUser = useCallback(
    (username: string) => {
      setOpen(false);
      onChange(username);
      onRoast(username);
    },
    [onChange, onRoast],
  );

  // Lock the current chip as side A and duel the picked opponent.
  const duelWith = useCallback(
    (opponent: string) => {
      if (!pkA) return;
      const [a, b] = [pkA.toLowerCase(), opponent.toLowerCase()].sort();
      setOpen(false);
      router.push(`/vs/${a}/${b}`);
    },
    [pkA, router],
  );

  const handleChange = useCallback(
    (next: string) => {
      setActiveIndex(-1);
      setOpen(true);
      // Auto-lock: as soon as the user completes a separator (`a vs `), turn the
      // left handle into a chip and start collecting the opponent.
      if (!pkA) {
        const parsed = parseOmnibox(next);
        if (suppressNextHalfLockRef.current && parsed.kind !== "pk-half") {
          suppressNextHalfLockRef.current = false;
        }
        if (shouldAutoLockPkIntent(parsed, suppressNextHalfLockRef.current)) {
          setPkA(parsed.a);
          onChange(parsed.kind === "pk" ? parsed.b : "");
          return;
        }
      }
      onChange(next);
    },
    [pkA, onChange],
  );

  const popChip = useCallback(() => {
    if (pkA == null) return;
    const restored = `${pkA} vs `;
    suppressNextHalfLockRef.current = true;
    setPkA(null);
    onChange(restored);
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [pkA, onChange]);

  // Localized label for one parsed suggestion row.
  const suggestionLabel = (s: OmniSuggestion): string => {
    switch (s.intent.kind) {
      case "user":
        return t("suggestRoast", { username: s.intent.username });
      case "pk-half":
        return t("suggestPkStart", { username: s.intent.a });
      case "pk":
        return t("suggestPk", { a: s.intent.a, b: s.intent.b });
      case "language":
        return t("suggestLanguage", { value: s.intent.value });
      case "org":
        return t("suggestOrg", { value: s.intent.value });
      case "repo":
        return `${s.intent.owner}/${s.intent.name}`;
      default:
        return "";
    }
  };

  // Combine parser rows with DB user rows (deduped), ordered 直达/对线/用户/发现.
  const dbLower = useMemo(
    () => new Set(dbUsers.map((u) => u.username.toLowerCase())),
    [dbUsers],
  );
  const rows = useMemo<Row[]>(() => {
    const intentRows: Row[] = suggestions
      // Drop the bare "roast @x" echo when the DB has that handle — the scored
      // row below is strictly richer.
      .filter(
        (s) => !(s.intent.kind === "user" && dbLower.has(s.intent.username.toLowerCase())),
      )
      .map((s, i) => ({
        key: `s${i}`,
        group: s.group,
        icon: intentIcon(s.intent.kind),
        label: suggestionLabel(s),
        hint: s.intent.kind === "pk-half" ? t("suggestPkHint") : undefined,
        activate: () => activateIntent(s.intent),
      }));
    const userRows: Row[] = dbUsers.map((u) => ({
      key: `u-${u.username}`,
      group: pkA ? "pk" : "user",
      icon: "@",
      label: `@${u.username}`,
      user: u,
      activate: pkA ? () => duelWith(u.username) : () => roastUser(u.username),
    }));
    return [...intentRows, ...userRows].sort(
      (a, b) => GROUP_ORDER[a.group] - GROUP_ORDER[b.group],
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [suggestions, dbUsers, dbLower, pkA, activateIntent, duelWith, roastUser]);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter") {
        e.preventDefault();
        if (busy) return;
        if (open && activeIndex >= 0 && activeIndex < rows.length) {
          rows[activeIndex].activate();
        } else {
          activateIntent(intent);
        }
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setOpen(true);
        setActiveIndex((i) => Math.min(i + 1, rows.length - 1));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setActiveIndex((i) => Math.max(i - 1, -1));
        return;
      }
      if (e.key === "Escape") {
        setOpen(false);
        setActiveIndex(-1);
        return;
      }
      // Backspace on an empty opponent field pops the locked chip back to text.
      if (e.key === "Backspace" && pkA != null && value === "") {
        e.preventDefault();
        popChip();
      }
    },
    [busy, open, activeIndex, rows, activateIntent, intent, pkA, value, popChip],
  );

  const groupLabel = (g: OmniSuggestion["group"]): string =>
    g === "direct"
      ? t("groupDirect")
      : g === "pk"
        ? t("groupPk")
        : g === "user"
          ? t("groupUser")
          : t("groupDiscover");

  return (
    <div className="relative w-full">
      <div className="flex w-full items-center gap-2 rounded-xl border border-white/10 bg-white/5 p-1.5 focus-within:border-orange-500/60">
        <span className="pl-3 text-lg leading-none text-zinc-400">{intentIcon(intent.kind)}</span>
        {pkA && (
          <span className="flex shrink-0 items-center gap-1 rounded-full bg-orange-500/15 py-1 pl-2.5 pr-1 text-sm font-medium text-orange-200 ring-1 ring-orange-400/30">
            @{pkA}
            <button
              type="button"
              onClick={popChip}
              aria-label={t("lockedRemove")}
              className="flex h-4 w-4 items-center justify-center rounded-full text-orange-300/80 hover:bg-orange-500/25 hover:text-orange-100"
            >
              ×
            </button>
          </span>
        )}
        <Input
          ref={inputRef}
          value={value}
          onChange={(e) => handleChange(e.target.value)}
          onKeyDown={onKeyDown}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 120)}
          placeholder={pkA ? t("pkHalfHint") : t(`placeholder${phIndex}`)}
          role="combobox"
          aria-expanded={open && rows.length > 0}
          aria-autocomplete="list"
          className="min-w-0 flex-1 border-0 bg-transparent px-1 py-2 text-base shadow-none focus-visible:ring-0"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
        />
        <Button
          type="button"
          onClick={() => !busy && activateIntent(intent)}
          disabled={busy}
          className="shrink-0 whitespace-nowrap bg-orange-600 text-white hover:bg-orange-500"
        >
          {ctaLabel}
        </Button>
      </div>

      {open && rows.length > 0 && (
        <ul
          role="listbox"
          className="absolute left-0 right-0 top-full z-30 mt-2 overflow-hidden rounded-xl border border-white/10 bg-zinc-950/95 py-1 shadow-2xl backdrop-blur"
        >
          {rows.map((row, i) => {
            const prevGroup = i > 0 ? rows[i - 1].group : null;
            const style = row.user ? tierStyle(row.user.tier) : null;
            return (
              <li key={row.key} role="none">
                {row.group !== prevGroup && (
                  <div className="px-3 pb-0.5 pt-2 text-[11px] font-medium uppercase tracking-wide text-zinc-500">
                    {groupLabel(row.group)}
                  </div>
                )}
                <button
                  type="button"
                  role="option"
                  aria-selected={i === activeIndex}
                  // onMouseDown (not onClick) so it fires before the input's blur.
                  onMouseDown={(e) => {
                    e.preventDefault();
                    row.activate();
                  }}
                  onMouseEnter={() => setActiveIndex(i)}
                  className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm ${
                    i === activeIndex ? "bg-white/10 text-zinc-100" : "text-zinc-300"
                  }`}
                >
                  {row.user ? (
                    <>
                      {row.user.avatar_url ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={row.user.avatar_url}
                          alt=""
                          className="h-6 w-6 shrink-0 rounded-full"
                        />
                      ) : (
                        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-white/10 text-xs">
                          @
                        </span>
                      )}
                      <span className="min-w-0 flex-1 truncate">
                        {row.label}
                        {row.user.display_name && (
                          <span className="ml-1.5 text-xs text-zinc-500">
                            {row.user.display_name}
                          </span>
                        )}
                      </span>
                      {style && (
                        <span
                          className={`shrink-0 text-xs font-bold tabular-nums ${style.text}`}
                        >
                          {style.emoji} {row.user.final_score.toFixed(1)}
                        </span>
                      )}
                    </>
                  ) : (
                    <>
                      <span className="text-base leading-none">{row.icon}</span>
                      <span className="min-w-0 flex-1 truncate">{row.label}</span>
                      {row.hint && (
                        <span className="shrink-0 text-xs text-zinc-500">{row.hint}</span>
                      )}
                    </>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

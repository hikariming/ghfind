import {
  adventurerLevel,
  formatAdventurerLevel,
  preciseScoreTitle,
  realmCssVars,
  realmForScore,
  type RealmDef,
} from "@/lib/realm";

/**
 * Big "Lv.97" with small "Lv." prefix (~45% size, lower baseline) and a muted
 * caption "冒险者等级" / "Adventurer Level". Precise score only in title tooltip.
 */
export function AdventurerLevel({
  score,
  realm: realmProp,
  caption,
  size = "lg",
  className,
  lang = "zh",
}: {
  score: number;
  realm?: RealmDef;
  caption: string;
  size?: "sm" | "md" | "lg" | "xl";
  className?: string;
  lang?: "zh" | "en";
}) {
  const realm = realmProp ?? realmForScore(score);
  const lv = adventurerLevel(score);
  const vars = realmCssVars(realm, "dark");

  const numSize =
    size === "xl" ? "text-7xl" : size === "lg" ? "text-6xl" : size === "md" ? "text-4xl" : "text-2xl";
  const prefixSize =
    size === "xl" ? "text-3xl" : size === "lg" ? "text-[1.7rem]" : size === "md" ? "text-lg" : "text-sm";

  const animClass = realm.effects.shimmer
    ? "realm-level-shimmer"
    : realm.effects.lightSweep
      ? "realm-level-sweep"
      : realm.colors.gradient
        ? "realm-level-grad"
        : "realm-level-solid";

  return (
    <div
      data-realm={realm.id}
      data-adventurer-level={lv}
      className={`flex flex-col items-center ${className ?? ""}`}
      style={vars}
      title={preciseScoreTitle(score, lang)}
    >
      {caption ? (
        <div className="text-[0.65rem] font-semibold uppercase tracking-[0.18em] text-zinc-500">
          {caption}
        </div>
      ) : null}
      <div className={`mt-0.5 flex items-baseline font-black tabular-nums leading-none ${numSize}`}>
        <span
          className={`realm-level-prefix ${prefixSize} font-bold`}
          style={{ transform: "translateY(0.18em)" }}
        >
          Lv.
        </span>
        <span className={`realm-level-num ${animClass}`}>{lv}</span>
      </div>
    </div>
  );
}

/** Compact inline `Lv.97` for tables/rails (no caption). */
export function AdventurerLevelInline({
  score,
  realm: realmProp,
  className,
  lang = "zh",
}: {
  score: number;
  realm?: RealmDef;
  className?: string;
  lang?: "zh" | "en";
}) {
  const realm = realmProp ?? realmForScore(score);
  const vars = realmCssVars(realm, "dark");
  return (
    <span
      data-realm={realm.id}
      className={`font-bold tabular-nums ${className ?? ""}`}
      style={{ ...vars, color: "var(--realm-fg)" }}
      title={preciseScoreTitle(score, lang)}
    >
      {formatAdventurerLevel(score)}
    </span>
  );
}

import type { RealmDef } from "@/lib/realm";

const SIZE = 15;

/** Small custom SVG mark (14–16px). Single-color = currentColor / fg. */
export function RealmGlyph({
  realm,
  size = SIZE,
  className,
}: {
  realm: RealmDef;
  size?: number;
  className?: string;
}) {
  const stroke = "currentColor";
  const fill = "currentColor";
  const common = {
    width: size,
    height: size,
    viewBox: "0 0 16 16",
    "aria-hidden": true as const,
    className,
    style: { color: "var(--realm-fg)", flexShrink: 0 },
  };

  if (realm.glyph === "dot") {
    return (
      <svg {...common}>
        <circle cx="8" cy="8" r="3.2" fill={fill} />
      </svg>
    );
  }
  if (realm.glyph === "core") {
    return (
      <svg {...common}>
        <circle cx="8" cy="8" r="5" fill="none" stroke={stroke} strokeWidth="1.4" />
        <circle cx="8" cy="8" r="2.4" fill={fill} />
      </svg>
    );
  }
  if (realm.glyph === "lotus") {
    // 4-petal mark
    return (
      <svg {...common}>
        <g fill={fill}>
          <ellipse cx="8" cy="4.2" rx="2.1" ry="3.2" />
          <ellipse cx="8" cy="11.8" rx="2.1" ry="3.2" />
          <ellipse cx="4.2" cy="8" rx="3.2" ry="2.1" />
          <ellipse cx="11.8" cy="8" rx="3.2" ry="2.1" />
          <circle cx="8" cy="8" r="1.6" />
        </g>
      </svg>
    );
  }
  // radiant 8-point star
  const star: string[] = [];
  for (let i = 0; i < 16; i++) {
    const a = (Math.PI / 8) * i - Math.PI / 2;
    const r = i % 2 === 0 ? 7 : 3.1;
    star.push(`${(8 + Math.cos(a) * r).toFixed(2)},${(8 + Math.sin(a) * r).toFixed(2)}`);
  }
  const useGrad = realm.rank >= 6;
  return (
    <svg {...common}>
      {useGrad ? (
        <defs>
          <linearGradient id={`rg-${realm.id}`} x1="0" y1="0" x2="1" y2="1">
            {(realm.colors.gradient ?? [realm.colors.fg, realm.colors.fg]).map((c, i, arr) => (
              <stop key={c + i} offset={`${(i / Math.max(1, arr.length - 1)) * 100}%`} stopColor={c} />
            ))}
          </linearGradient>
        </defs>
      ) : null}
      <polygon
        points={star.join(" ")}
        fill={useGrad ? `url(#rg-${realm.id})` : fill}
      />
    </svg>
  );
}

export function RealmChip({
  realm,
  name,
  className,
}: {
  realm: RealmDef;
  name: string;
  className?: string;
}) {
  return (
    <span
      data-realm={realm.id}
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-sm font-bold tracking-wide ${className ?? ""}`}
      style={{
        color: "var(--realm-fg)",
        backgroundColor: "var(--realm-glow)",
        boxShadow: `inset 0 0 0 1px color-mix(in srgb, var(--realm-ring) 35%, transparent)`,
      }}
    >
      <RealmGlyph realm={realm} size={14} />
      {name}
    </span>
  );
}

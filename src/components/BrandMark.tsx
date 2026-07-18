import type { CSSProperties } from "react";

interface BrandMarkProps {
  className?: string;
  style?: CSSProperties;
}

export const BRAND_MARK_PATHS = {
  orbit: [
    "M11.25 4.22A12.25 12.25 0 0 0 4.12 18.9",
    "M7.02 25.14a12.25 12.25 0 0 0 17.96 0",
    "M27.88 18.9a12.25 12.25 0 0 0-7.13-14.68",
  ],
  coreLeft: "m14.25 10.25-5.5 5.75 5.5 5.75",
  coreRight: "m17.75 10.25 5.5 5.75-5.5 5.75",
} as const;

export function BrandMark({ className, style }: BrandMarkProps) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      style={style}
      viewBox="0 0 32 32"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <g
        data-brand-part="social-orbit"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="2.25"
      >
        {BRAND_MARK_PATHS.orbit.map((path) => (
          <path key={path} d={path} />
        ))}
      </g>

      <g fill="currentColor">
        <circle cx="16" cy="3.5" r="2.5" />
        <circle cx="5.25" cy="23.5" r="2.5" />
        <circle cx="26.75" cy="23.5" r="2.5" />
      </g>

      <g
        data-brand-part="code-core"
        strokeLinecap="square"
        strokeLinejoin="miter"
        strokeWidth="3.5"
      >
        <path d={BRAND_MARK_PATHS.coreLeft} stroke="currentColor" />
        <path d={BRAND_MARK_PATHS.coreRight} stroke="#f97316" />
      </g>
    </svg>
  );
}

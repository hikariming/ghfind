import { Link } from "@/i18n/navigation";

const COPY = {
  zh: "🔥ADVX2026现场一决高下🔥",
  default: "🔥 Face off live at ADVX 2026 🔥",
} as const;

export function HomeEventBanner({ locale }: { locale: string }) {
  const label = locale === "zh" ? COPY.zh : COPY.default;

  return (
    <Link
      href="/advx?theme=dark"
      className="group mb-8 flex min-h-16 w-full max-w-6xl items-center justify-center overflow-hidden rounded-2xl border border-orange-400/30 bg-orange-500/[0.04] px-4 py-3 text-center shadow-[inset_0_1px_0_rgba(255,255,255,0.06)] transition-colors hover:bg-orange-500/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500/60 focus-visible:ring-offset-2 focus-visible:ring-offset-background sm:mb-10"
    >
      <span className="text-base font-black tracking-tight text-orange-200 sm:text-lg">
        {label}
      </span>
      <span
        aria-hidden="true"
        className="ms-2 text-orange-400 transition-transform group-hover:translate-x-0.5"
      >
        →
      </span>
    </Link>
  );
}

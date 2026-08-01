"use client";

import { Link } from "@/i18n/navigation";
import { trackEvent } from "@/lib/track";

/**
 * One homepage editor's-picks card. Client island only for the click beacon —
 * all copy arrives pre-localized from the server `HomeCollections` band.
 */
export function CollectionPromoCard({
  slug,
  position,
  title,
  intro,
  typeLabel,
  avatarUrl,
  metaLine,
}: {
  slug: string;
  position: number;
  title: string;
  intro: string;
  typeLabel: string;
  avatarUrl: string | null;
  metaLine: string;
}) {
  return (
    <Link
      href={`/collections/${slug}`}
      prefetch={false}
      onClick={() => trackEvent("home_collections_click", { slug, position })}
      className="group flex flex-col rounded-2xl border border-white/10 bg-white/[0.035] p-5 transition-colors hover:border-white/20 hover:bg-white/[0.055]"
    >
      <div className="flex items-center gap-3">
        {avatarUrl && (
          // eslint-disable-next-line @next/next/no-img-element -- GitHub avatar; the image optimizer would just add Vercel cost
          <img
            src={avatarUrl}
            alt=""
            loading="lazy"
            className="h-10 w-10 shrink-0 rounded-full ring-2 ring-orange-400/40"
          />
        )}
        <span className="rounded-full bg-orange-500/10 px-2.5 py-1 text-xs font-semibold text-orange-200">
          {typeLabel}
        </span>
      </div>
      <h3 className="mt-3 line-clamp-2 text-lg font-bold text-zinc-100 group-hover:text-white">
        {title}
      </h3>
      <p className="mt-2 line-clamp-2 text-sm leading-relaxed text-zinc-400">{intro}</p>
      <div className="mt-auto pt-4 text-xs text-zinc-500">{metaLine}</div>
    </Link>
  );
}

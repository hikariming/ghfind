"use client";

import { useState } from "react";
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
  githubUsername,
  identityName,
  avatarUrl,
  metaLine,
}: {
  slug: string;
  position: number;
  title: string;
  intro: string;
  typeLabel: string;
  githubUsername: string | null;
  identityName?: string;
  avatarUrl: string | null;
  metaLine: string;
}) {
  const [avatarFailed, setAvatarFailed] = useState(false);
  const avatarInitial = (githubUsername ?? identityName ?? "?").trim().slice(0, 1);

  return (
    <article className="group relative flex flex-col rounded-2xl border border-white/10 bg-white/[0.035] p-5 transition-colors hover:border-white/20 hover:bg-white/[0.055]">
      <Link
        href={`/collections/${slug}`}
        prefetch={false}
        onClick={() => trackEvent("home_collections_click", { slug, position })}
        aria-label={title}
        className="absolute inset-0 rounded-2xl focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-orange-300"
      />
      {(avatarUrl || identityName) && (
        <div className="relative z-10 flex min-w-0 items-center gap-3">
        <span className="relative flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-full bg-orange-500/10 text-sm font-bold text-orange-300 ring-2 ring-orange-400/40">
          <span aria-hidden="true">{avatarInitial}</span>
          {avatarUrl && !avatarFailed && (
            // eslint-disable-next-line @next/next/no-img-element -- GitHub avatar; the image optimizer would just add Vercel cost
            <img
              src={avatarUrl}
              alt={`${githubUsername ?? identityName ?? "GitHub"} avatar`}
              loading="lazy"
              onError={() => setAvatarFailed(true)}
              className="absolute inset-0 h-full w-full rounded-full bg-transparent"
            />
          )}
          </span>
          {githubUsername ? (
            <a
              href={`https://github.com/${githubUsername}`}
              target="_blank"
              rel="noreferrer"
              className="min-w-0 truncate text-sm font-semibold text-zinc-100 underline-offset-4 hover:text-white hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-orange-300"
            >
              <span>{githubUsername}</span>
              {identityName && identityName !== githubUsername && (
                <span className="font-normal text-zinc-400"> · {identityName}</span>
              )}
            </a>
          ) : (
            <span className="min-w-0 truncate text-sm font-semibold text-zinc-100">
              {identityName}
            </span>
          )}
        </div>
      )}
      <h3 className="pointer-events-none relative z-10 mt-3 line-clamp-2 text-lg font-bold text-zinc-100 group-hover:text-white">
        {title}
      </h3>
      <p className="pointer-events-none relative z-10 mt-2 line-clamp-2 text-sm leading-relaxed text-zinc-400">
        {intro}
      </p>
      <div className="pointer-events-none relative z-10 mt-auto flex items-center justify-between gap-3 pt-4 text-xs text-zinc-500">
        <span>{metaLine}</span>
        <span className="shrink-0 rounded-full bg-orange-500/10 px-2.5 py-1 font-semibold text-orange-200">
          {typeLabel}
        </span>
      </div>
    </article>
  );
}

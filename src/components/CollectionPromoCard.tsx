"use client";

import { ArrowUpRight } from "lucide-react";
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
    <article className="collection-card group">
      {/* Stretched link: any part of the card opens the collection. Kept as a
          real <a> so cmd/ctrl-click opens a new tab. Nothing else in the card
          is interactive — anything added later needs `relative z-10`. */}
      <Link
        href={`/collections/${slug}`}
        prefetch={false}
        aria-label={title}
        onClick={() => trackEvent("home_collections_click", { slug, position })}
        className="collection-card-link"
      />
      {(avatarUrl || identityName) && (
        <div className="collection-identity">
          {/* Decorative, and `relative` for the avatar image — kept transparent
              to hit-testing so it doesn't punch a hole in the stretched link. */}
          <span className="collection-avatar">
            <span aria-hidden="true">{avatarInitial}</span>
            {avatarUrl && !avatarFailed && (
              // eslint-disable-next-line @next/next/no-img-element -- GitHub avatar; the image optimizer would just add Vercel cost
              <img
                src={avatarUrl}
                alt={`${githubUsername ?? identityName ?? "GitHub"} avatar`}
                loading="lazy"
                onError={() => setAvatarFailed(true)}
                className="rounded-none"
              />
            )}
          </span>
          <span className="collection-identity-name">
            {githubUsername ?? identityName}
            {githubUsername && identityName && identityName !== githubUsername && (
              <span className="font-normal text-zinc-400"> · {identityName}</span>
            )}
          </span>
          <ArrowUpRight className="collection-arrow" aria-hidden="true" />
        </div>
      )}
      <h3 className="line-clamp-2">
        {title}
      </h3>
      <p className="line-clamp-2">{intro}</p>
      <div className="collection-meta">
        <span>{typeLabel}</span>
        <span aria-hidden="true">/</span>
        <span>{metaLine}</span>
      </div>
    </article>
  );
}

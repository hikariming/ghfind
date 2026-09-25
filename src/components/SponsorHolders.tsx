"use client";

import { SponsorMark } from "@/components/SponsorMark";
import { useSponsorRecords } from "@/components/SponsorData";
import type { SponsorTier } from "@/lib/sponsorships";
import styles from "@/components/SponsorHolders.module.css";

export function SponsorHolders({
  tier,
  wrapperClassName,
  className,
  logoClassName,
  anonymousLabel,
  label,
  empty,
  scroll = false,
}: {
  tier: SponsorTier;
  wrapperClassName?: string;
  className: string;
  logoClassName: string;
  anonymousLabel: string;
  label?: string;
  empty?: { className: string; text: string; href?: string };
  scroll?: boolean;
}) {
  const sponsors = useSponsorRecords();
  if (!sponsors) return null;
  const holders = sponsors?.filter((sponsor) => sponsor.tier === tier) ?? [];
  if (holders.length === 0) {
    if (!empty) return null;
    return empty.href
      ? <a className={empty.className} href={empty.href}>{empty.text}</a>
      : <span className={empty.className}>{empty.text}</span>;
  }

  const showScroll = scroll && holders.length > 1;
  const renderHolder = (holder: (typeof holders)[number], duplicate = false) => {
    const name = holder.isAnonymous ? anonymousLabel : holder.name ?? anonymousLabel;
    const contents = (
      <>
        <SponsorMark holder={holder} className={logoClassName} />
        <span>{name}</span>
      </>
    );
    if (duplicate || !holder.url) {
      return <span key={holder.id} className={className}>{contents}</span>;
    }
    return (
      <a
        key={holder.id}
        href={holder.url}
        target="_blank"
        rel="noopener noreferrer sponsored"
        className={className}
      >
        {contents}
      </a>
    );
  };

  if (!scroll) {
    return (
      <div className={wrapperClassName}>
        {holders.map((holder) => renderHolder(holder))}
      </div>
    );
  }

  return (
    <div className={styles.sponsorList}>
      {label && <span className={styles.label}>{label}</span>}
      <div className={styles.viewport}>
        <div className={`${styles.track} ${showScroll ? styles.animated : ""}`}>
          <div className={styles.group}>{holders.map((holder) => renderHolder(holder))}</div>
          {showScroll && <div className={styles.group} aria-hidden="true">{holders.map((holder) => renderHolder(holder, true))}</div>}
        </div>
      </div>
    </div>
  );
}

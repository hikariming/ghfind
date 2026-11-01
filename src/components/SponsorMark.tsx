import type { SponsorRecord } from "@/lib/sponsorships";

/**
 * A sponsor's logo, or a lettermark tile when they have none. Shared by the
 * /sponsor page and the homepage sponsor row so both render the same identity.
 */
export function SponsorMark({ holder, className }: { holder: SponsorRecord; className?: string }) {
  if (holder.iconUrl) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img src={holder.iconUrl} alt="" className={className} />
    );
  }
  const mark = holder.mark ?? holder.name?.slice(0, 2).toUpperCase() ?? "?";
  return <span className={`sponsor-lettermark ${className ?? ""}`} aria-hidden>{mark}</span>;
}

"use client";

import { useLocale } from "next-intl";
import { useState } from "react";
import { useMountEffect } from "@/lib/use-mount-effect";
import type { SponsorRecord, SponsorsResponse } from "@/lib/sponsorships";

/** One request per locale per page load, shared by every sponsor surface. */
const sponsorsRequests = new Map<string, Promise<SponsorRecord[]>>();

function fetchSponsors(locale: string): Promise<SponsorRecord[]> {
  let sponsorsRequest = sponsorsRequests.get(locale);
  if (!sponsorsRequest) {
    sponsorsRequest = fetch(`/api/sponsors?locale=${encodeURIComponent(locale)}`, { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) return [];
        const payload = (await response.json()) as SponsorsResponse;
        return Array.isArray(payload.sponsors) ? payload.sponsors : [];
      })
      .catch(() => []);
    sponsorsRequests.set(locale, sponsorsRequest);
  }
  return sponsorsRequest;
}

export function useSponsorRecords(): SponsorRecord[] | null {
  const locale = useLocale();
  const [sponsors, setSponsors] = useState<SponsorRecord[] | null>(null);

  useMountEffect(() => {
    let cancelled = false;
    void fetchSponsors(locale).then((records) => {
      if (!cancelled) setSponsors(records);
    });
    return () => {
      cancelled = true;
    };
  });

  return sponsors;
}

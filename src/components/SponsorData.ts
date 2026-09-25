"use client";

import { useState } from "react";
import { useMountEffect } from "@/lib/use-mount-effect";
import type { SponsorRecord, SponsorsResponse } from "@/lib/sponsorships";

let sponsorsRequest: Promise<SponsorRecord[]> | null = null;

function fetchSponsors(): Promise<SponsorRecord[]> {
  if (!sponsorsRequest) {
    sponsorsRequest = fetch("/api/sponsors", { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) return [];
        const payload = (await response.json()) as SponsorsResponse;
        return Array.isArray(payload.sponsors) ? payload.sponsors : [];
      })
      .catch(() => []);
  }
  return sponsorsRequest;
}

export function useSponsorRecords(): SponsorRecord[] | null {
  const [sponsors, setSponsors] = useState<SponsorRecord[] | null>(null);

  useMountEffect(() => {
    let cancelled = false;
    void fetchSponsors().then((records) => {
      if (!cancelled) setSponsors(records);
    });
    return () => {
      cancelled = true;
    };
  });

  return sponsors;
}

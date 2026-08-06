import "server-only";

import { getGoPublicData } from "@/lib/go-backend.server";
import type { ProfilePresentation, VsMatchup, VsPresentation } from "@/lib/profile-presentation";
import type { ScanResult } from "@/lib/types";

/** Go-owned public profile model for server pages and locally rendered cards. */
export function getGoProfilePresentation(username: string) {
  return getGoPublicData<ProfilePresentation>(`/api/profile/${encodeURIComponent(username)}`);
}

/** Go-owned public model for one canonical versus pair. */
export function getGoVsPresentation(a: string, b: string) {
  return getGoPublicData<VsPresentation>(
    `/api/vs/${encodeURIComponent(a)}/${encodeURIComponent(b)}`,
  );
}

export async function getGoTrendingVsMatchups() {
  const data = await getGoPublicData<{ matchups: VsMatchup[] }>("/api/vs/trending");
  return data?.matchups ?? [];
}

/** Cached-only read for the transient profile shell; never starts a scan. */
export async function getGoLiveProfileScan(username: string) {
  const data = await getGoPublicData<{ scan: ScanResult }>(
    `/api/profile/${encodeURIComponent(username)}/live`,
  );
  return data?.scan ?? null;
}

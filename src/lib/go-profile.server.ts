import "server-only";

/**
 * Locally assembled profile/versus presentation models. The exported names keep
 * their historical Go-fetching signatures (null on any failure, so pages can
 * keep their `null → notFound()` handling) while the data now comes straight
 * from Turso via profile-presentation.server.ts.
 */
import {
  buildProfilePresentation,
  buildVsPresentation,
  getLiveProfileScan,
  getTrendingVsMatchupsLocal,
} from "@/lib/profile-presentation.server";
import type { ProfilePresentation, VsMatchup, VsPresentation } from "@/lib/profile-presentation";
import type { ScanResult } from "@/lib/types";

/** Public profile model for server pages and locally rendered cards. */
export async function getGoProfilePresentation(
  username: string,
): Promise<ProfilePresentation | null> {
  try {
    return await buildProfilePresentation(username);
  } catch {
    return null;
  }
}

/** Public model for one canonical versus pair. */
export async function getGoVsPresentation(a: string, b: string): Promise<VsPresentation | null> {
  try {
    return await buildVsPresentation(a, b);
  } catch {
    return null;
  }
}

export async function getGoTrendingVsMatchups(): Promise<VsMatchup[]> {
  try {
    return await getTrendingVsMatchupsLocal();
  } catch {
    return [];
  }
}

/** Cached-only read for the transient profile shell; never starts a scan. */
export async function getGoLiveProfileScan(username: string): Promise<ScanResult | null> {
  try {
    return await getLiveProfileScan(username);
  } catch {
    return null;
  }
}

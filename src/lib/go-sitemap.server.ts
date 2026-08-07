import "server-only";

import { getGoPublicData } from "@/lib/go-backend.server";

export interface GoSitemapProfile {
  username: string;
  scanned_at: number;
}

export interface GoSitemapMatchup {
  a: string;
  b: string;
  updatedAt: number;
}

export async function getGoSitemapInventory() {
  return getGoPublicData<{ profiles: GoSitemapProfile[]; matchups: GoSitemapMatchup[] }>(
    "/api/sitemap",
  );
}

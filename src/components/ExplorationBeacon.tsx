"use client";

import { useEffect } from "react";
import {
  recordExplorationItem,
  type ExplorationItemInput,
} from "@/lib/exploration-history";

export function ExplorationBeacon({ item }: { item: ExplorationItemInput }) {
  const { href, key, kind, subtitle, title } = item;
  useEffect(() => {
    recordExplorationItem({ href, key, kind, subtitle, title });
  }, [href, key, kind, subtitle, title]);
  return null;
}

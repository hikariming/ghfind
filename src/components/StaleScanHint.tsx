"use client";

import { useSyncExternalStore } from "react";
import { useTranslations } from "next-intl";
import { readSessionScan } from "@/lib/home-handoff";

export function isStaleScanPayload(value: unknown): boolean {
  return Boolean(
    value &&
      typeof value === "object" &&
      "stale" in value &&
      (value as { stale?: unknown }).stale === true,
  );
}

function subscribe() {
  return () => {};
}

/** Light homepage/profile caption when /api/scan served a stale emergency snapshot. */
export function StaleScanHint({
  show,
  username,
}: {
  show?: boolean;
  username?: string;
}) {
  const t = useTranslations("roaster");
  const handoffStale = useSyncExternalStore(
    subscribe,
    () => (username ? isStaleScanPayload(readSessionScan(username)) : false),
    () => false,
  );
  if (!show && !handoffStale) return null;
  return (
    <p className="mt-2 text-xs font-medium text-zinc-500" role="status">
      {t("dataUpdating")}
    </p>
  );
}

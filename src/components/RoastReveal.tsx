"use client";

import { useEffect, useState } from "react";
import { stripRoastingParam } from "@/lib/home-handoff";
import { trackEvent } from "@/lib/track";
import type { RoastMeta } from "@/lib/types";
import { RoastResultModal } from "./RoastResultModal";

/**
 * Auto-opens the share popup over an already-rendered (SSR) profile when the
 * visitor arrives from the homepage input and the stored roast is still fresh
 * (<24h) — replaying the stored result keeps the share/screenshot moment
 * without an LLM call. The `?roasting=1` handoff marker is spent on mount, so
 * reloads and copied links behave like direct visits (no repeat popup).
 * Renders nothing besides the modal; the page underneath is the full profile.
 */
export function RoastReveal({
  username,
  name,
  avatarUrl,
  meta,
  orgs,
}: {
  username: string;
  name: string | null;
  avatarUrl: string | null;
  meta: RoastMeta;
  orgs?: string[];
}) {
  // Opened via effect (not initial state) so the SSR payload stays popup-free
  // and the open happens strictly after the handoff marker is consumed.
  const [open, setOpen] = useState(false);
  useEffect(() => {
    stripRoastingParam();
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-shot open after the handoff marker is spent; runs exactly once
    setOpen(true);
    trackEvent("roast_reveal", { cached: true });
  }, []);

  if (!open) return null;
  return (
    <RoastResultModal
      open
      onClose={() => setOpen(false)}
      username={username}
      name={name}
      avatarUrl={avatarUrl}
      meta={meta}
      orgs={orgs}
    />
  );
}

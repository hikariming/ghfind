"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Handshake } from "lucide-react";
import { getTalentProfile, setOpenToOpportunities } from "@/lib/talent-match/client";
import { Card } from "./parts";

/**
 * Consent for the account's current Talent Match profile to join the talent
 * pool that company matching (phase 3) searches. Renders nothing until the
 * account has a profile, which the first finished report creates.
 */
export function OpenToOpportunities() {
  const t = useTranslations("talentMatch.optIn");
  const [optedIn, setOptedIn] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    getTalentProfile().then((result) => {
      if (live && result.ok && result.value.profile) setOptedIn(result.value.profile.optedIn);
    });
    return () => { live = false; };
  }, []);

  if (optedIn === null) return null;

  const toggle = async (next: boolean) => {
    setOptedIn(next);
    setSaving(true);
    setFailed(false);
    const result = await setOpenToOpportunities(next);
    setSaving(false);
    if (!result.ok) {
      setOptedIn(!next);
      setFailed(true);
    }
  };

  return (
    <Card title={t("title")} aside={<Handshake className="h-4 w-4 text-zinc-500" aria-hidden="true" />}>
      <label className="flex items-start gap-3">
        <input type="checkbox" className="mt-1" checked={optedIn} disabled={saving} onChange={(e) => void toggle(e.target.checked)} />
        <span>
          <span className="block text-sm font-medium text-zinc-100">{t("label")}</span>
          <span className="mt-1 block text-xs text-zinc-500">{t("detail")}</span>
        </span>
      </label>
      <p className="mt-3 text-xs text-zinc-500" aria-live="polite">{optedIn ? t("on") : t("off")} {t("notLive")}</p>
      {failed && <p role="alert" className="mt-3 rounded-xl bg-red-500/10 px-3 py-2 text-xs text-rose-400">{t("saveFailed")}</p>}
    </Card>
  );
}

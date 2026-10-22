import { cache, Suspense } from "react";
import { notFound } from "next/navigation";
import { headers } from "next/headers";
import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { PendingProfile } from "./PendingProfile";
import { localeAlternates, localePath } from "@/lib/site";
import { ProfileReactionsSection } from "@/components/ProfileReactionsSection";
import { ProfileView } from "@/components/pages/ProfileView";
import { auth } from "@/lib/auth";
import { UnratedProfile } from "@/components/pages/UnratedProfile";
import { getProfileComments, getRetiredAccountIdentity } from "@/lib/db";
import { oauthConfigured } from "@/lib/oauth-config";
import { getGoLiveProfileScan, getGoProfilePresentation } from "@/lib/go-profile.server";
import { loadProfileRoastState, profileMetadata } from "@/lib/pages/profile";
import { decodeRouteParam } from "@/lib/route-params";
import { asTranslator } from "@/lib/translator";

// Profile comments must be fresh; score/roast data is still fetched from the DB
// and remains cached at the persistence layer where applicable.
export const dynamic = "force-dynamic";

// Dedupe Go presentation reads between metadata and the page render.
const getProfile = cache((username: string) => getGoProfilePresentation(username));
const getRetiredIdentity = cache(getRetiredAccountIdentity);
const getLiveScan = cache((username: string) => getGoLiveProfileScan(username));

export async function generateMetadata({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string; username: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}): Promise<Metadata> {
  const { locale, username } = await params;
  const t = await getTranslations({ locale, namespace: "detailMeta" });
  const decoded = decodeRouteParam(username);
  const d = (await getProfile(decoded))?.detail ?? null;
  if (!d) {
    // No persisted row yet. A cached scan or the `?roasting=1` handoff marker
    // means we render the live-roast pending shell rather than 404 — give it a
    // title and keep it out of search (it's transient).
    const scan = await getLiveScan(decoded);
    const roasting = (await searchParams)?.roasting === "1";
    if (scan || roasting) {
      return {
        title: t("pendingTitle", { username: scan?.metrics.username ?? decoded }),
        robots: { index: false, follow: true },
      };
    }
    const identity = await getRetiredIdentity(decoded);
    if (identity) return { title: t("unratedTitle", { username: identity.username }), robots: { index: false, follow: true }, alternates: localeAlternates(locale, `/u/${decoded}`) };
    return { title: t("notFoundTitle") };
  }

  const tt = await getTranslations({ locale, namespace: "tiers" });
  const { title, description, image, imageAlt, path, indexable } = profileMetadata(
    locale,
    d,
    asTranslator(t),
    asTranslator(tt),
  );
  return {
    title,
    description,
    robots: indexable ? undefined : { index: false, follow: true },
    alternates: localeAlternates(locale, path),
    openGraph: {
      title,
      description,
      url: localePath(locale, path),
      type: "website",
      images: [{ url: image, width: 1200, height: 630, alt: imageAlt, type: "image/png" }],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: [{ url: image, alt: imageAlt }],
    },
  };
}

export default async function AccountPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string; username: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const { locale, username } = await params;
  setRequestLocale(locale);
  const query = await searchParams;
  const isAdvxCampaign = query.campaign === "advx";
  const decoded = decodeRouteParam(username);
  const presentation = await getProfile(decoded);
  const d = presentation?.detail ?? null;
  if (!presentation || !d) {
    // First-time username being roasted right now: no `scores` row yet. Render
    // the live pending shell when we have a scan to show — either the server-side
    // cache, or the `?roasting=1` handoff (the shell reads the scan the homepage
    // stashed in sessionStorage). LiveRoast refreshes into the full profile on
    // completion. Otherwise it's a genuine unknown handle → 404.
    const scan = await getLiveScan(decoded);
    const roasting = query.roasting === "1";
    if (!scan && !roasting) {
      const identity = await getRetiredIdentity(decoded);
      if (!identity) notFound();
      const t = await getTranslations("detail");
      return <UnratedProfile {...identity} locale={locale} message={t("unratedMessage")} action={t("unratedAction")} github={t("unratedGithub")} />;
    }
    return (
      <PendingProfile
        username={decoded}
        initialScan={scan ?? null}
        fromHome={roasting}
        advx={isAdvxCampaign}
      />
    );
  }

  // Homepage handoff: the input box navigated here with `?roasting=1`. That
  // arrival must always get the result popup — replayed from the stored roast
  // when it's still fresh, or via a forced regeneration when it has gone stale.
  // Direct visits / shared links (no param) keep the popup-free SSR page.
  const fromHome = query.roasting === "1";
  const [t, tDim, tTier, roastState, comments, session, requestHeaders] = await Promise.all([
    getTranslations("detail"),
    getTranslations("dimensions"),
    getTranslations("tiers"),
    loadProfileRoastState(d, locale, fromHome, getLiveScan),
    getProfileComments(d.username),
    oauthConfigured() ? auth() : Promise.resolve(null),
    headers(),
  ]);
  return (
    <ProfileView
      locale={locale}
      presentation={presentation}
      isAdvxCampaign={isAdvxCampaign}
      fromHome={fromHome}
      refParam={query.ref}
      referer={requestHeaders.get("referer")}
      viewerLogin={session?.user?.login ?? null}
      comments={comments}
      {...roastState}
      reactions={
        <Suspense
          fallback={
            <div className="h-28 animate-pulse rounded-2xl border border-orange-300/15 bg-orange-500/[0.035]" />
          }
        >
          <ProfileReactionsSection
            key={`reactions-${d.username}`}
            username={d.username}
            redirectTo={localePath(locale, `/u/${d.username}`)}
            flat={isAdvxCampaign}
          />
        </Suspense>
      }
      t={asTranslator(t)}
      tDim={asTranslator(tDim)}
      tTier={asTranslator(tTier)}
    />
  );
}

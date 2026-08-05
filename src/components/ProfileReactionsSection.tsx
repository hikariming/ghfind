import { redirect } from "next/navigation";
import { ProfileReactions } from "@/components/ProfileReactions";
import { getGoPrivateData } from "@/lib/go-backend.server";
import { oauthConfigured } from "@/lib/oauth-config";
import { emptyReactionCounts, type ProfileReactionState } from "@/lib/reactions";

/**
 * Server wrapper that resolves auth + reaction state for one profile. Kept
 * separate so the profile page can stream it inside <Suspense> — the session
 * lookup and reaction queries no longer block the page's first paint.
 */
export async function ProfileReactionsSection({
  username,
  redirectTo,
  flat = false,
}: {
  username: string;
  redirectTo: string;
  flat?: boolean;
}) {
  const authAvailable = oauthConfigured();
  const session = authAvailable
    ? await getGoPrivateData<{ user: { login: string; image: string | null } | null }>("/api/me")
    : null;
  const reactionState =
    (await getGoPrivateData<ProfileReactionState>(
      `/api/profile-reactions/${encodeURIComponent(username)}`,
    )) ?? { counts: emptyReactionCounts(), viewerReaction: null };

  async function signInForReaction() {
    "use server";
    redirect(`/api/auth/github?callbackUrl=${encodeURIComponent(redirectTo)}`);
  }

  return (
    <ProfileReactions
      authenticated={Boolean(session?.user)}
      authAvailable={authAvailable}
      initialState={reactionState}
      profileUsername={username}
      signInAction={signInForReaction}
      flat={flat}
    />
  );
}

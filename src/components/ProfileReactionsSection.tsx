import { ProfileReactions } from "@/components/ProfileReactions";
import { auth } from "@/lib/auth";
import { getProfileReactionState } from "@/lib/db";
import { oauthConfigured } from "@/lib/oauth-config";

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
  const session = authAvailable ? await auth() : null;
  const reactionState = await getProfileReactionState(username, session?.user.githubId);

  return (
    <ProfileReactions
      authenticated={Boolean(session)}
      authAvailable={authAvailable}
      initialState={reactionState}
      profileUsername={username}
      signInCallbackUrl={redirectTo}
      flat={flat}
    />
  );
}

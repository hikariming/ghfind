import { auth, authConfigured, signIn } from "@/lib/auth";
import { getProfileReactionState } from "@/lib/db";
import { ProfileReactions } from "@/components/ProfileReactions";

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
  const authAvailable = authConfigured();
  const session = authAvailable ? await auth() : null;
  const reactionState = await getProfileReactionState(username, session?.user.githubId);

  async function signInForReaction() {
    "use server";
    await signIn("github", { redirectTo });
  }

  return (
    <ProfileReactions
      authenticated={Boolean(session?.user.githubId)}
      authAvailable={authAvailable}
      initialState={reactionState}
      profileUsername={username}
      signInAction={signInForReaction}
      flat={flat}
    />
  );
}

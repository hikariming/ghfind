import { decodeSignedPayload, encodeSignedPayload, oauthConfigured } from "@/lib/oauth-session";

/** A provider identity is not a GitHub identity and cannot grant GitHub privileges. */
export type SocialSession = {
  provider: "google" | "apple";
  subject: string;
  name: string;
  image: string | null;
  expires_at: number;
};

export function googleOAuthConfigured(): boolean {
  return process.env.GHFIND_OAUTH_ENABLED?.trim() !== "0" && Boolean(
    process.env.AUTH_GOOGLE_ID?.trim() &&
    process.env.AUTH_GOOGLE_SECRET?.trim() &&
    process.env.AUTH_SECRET?.trim(),
  );
}

export function configuredOAuthProviders() {
  return {
    github: oauthConfigured() && process.env.GHFIND_OAUTH_ENABLED?.trim() !== "0",
    google: googleOAuthConfigured(),
    // Enable only after Apple Developer credentials and its callback are ready.
    apple: false,
  };
}

export function encodeSocialSession(session: SocialSession): string {
  return encodeSignedPayload("social-session", session);
}

export function readSocialSession(raw: string | undefined): SocialSession | null {
  if (!raw) return null;
  const session = decodeSignedPayload<SocialSession>("social-session", raw);
  if (!session || (session.provider !== "google" && session.provider !== "apple")) return null;
  if (typeof session.subject !== "string" || !session.subject || session.subject.length > 255) return null;
  if (typeof session.name !== "string" || !session.name.trim() || session.name.length > 200) return null;
  if (!Number.isSafeInteger(session.expires_at) || session.expires_at <= Date.now()) return null;
  if (session.image !== null) {
    if (typeof session.image !== "string" || session.image.length > 2048) return null;
    try {
      const image = new URL(session.image);
      if (image.protocol !== "https:" || image.username || image.password) return null;
    } catch {
      return null;
    }
  }
  return session;
}

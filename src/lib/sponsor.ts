/**
 * Current sponsor — single source of truth.
 *
 * Drives the on-site credits AND the live `/api/card` image. Because the card is
 * rendered on every request (not a frozen PNG), changing this constant (or its
 * env overrides) and redeploying updates every already-embedded card within the
 * CDN/camo cache window. Swap sponsor / edit text / remove here, one place.
 */
export const SPONSOR = {
  name: process.env.SPONSOR_NAME || "LobeHub",
  url: process.env.SPONSOR_URL || "https://lobehub.com",
  logo: "/lobehub.png",
  /**
   * 32px re-encode of the same mark. The SVG cards inline the logo as base64
   * into every response but only draw it around 13px, where the 192px original
   * would cost ~12KB of the payload on the endpoint camo hits hardest.
   */
  logoSmall: "/lobehub-32.png",
};

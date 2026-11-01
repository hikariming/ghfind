import { SITE_URL } from "@/lib/site";

/** Resolve server-side: the shared integrations view also hydrates in Astro,
 * where Node's process.env is unavailable in the browser. */
export function installCommand(): string {
  return SITE_URL === "https://ghfind.com"
    ? "curl -fsSL https://ghfind.com/install.sh | bash"
    : `curl -fsSL ${SITE_URL}/install.sh | GHFIND_INSTALL_HOST=${SITE_URL} bash`;
}

import createMiddleware from "next-intl/middleware";
import { routing } from "@/i18n/routing";

export default createMiddleware(routing);

export const config = {
  // Run on everything EXCEPT API routes, Next internals, and static files (any
  // path containing a dot). This keeps `/api/badge`, `/api/card`, etc. — the
  // README-embedded endpoints — prefix-free and untouched.
  matcher: "/((?!api|_next|_vercel|.*\\..*).*)",
};

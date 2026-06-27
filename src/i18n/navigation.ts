import { createNavigation } from "next-intl/navigation";
import { routing } from "./routing";

/**
 * Locale-aware navigation helpers. Use these instead of `next/link` and
 * `next/navigation` so links automatically carry the `/en` prefix when the
 * active locale is English (and stay prefix-free for the zh default).
 */
export const { Link, redirect, usePathname, useRouter, getPathname } =
  createNavigation(routing);

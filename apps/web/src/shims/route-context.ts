import { createContext, useContext } from "react";
import type { Locale } from "@ghfind/i18n";

/** Request routing facts an island needs during SSR, where `window` is absent. */
export interface RouteInfo {
  locale: Locale;
  /** Locale-agnostic path of the current page, e.g. `/about`. */
  pathname: string;
  /** Query string of the request (with or without `?`), for useSearchParams during SSR. */
  search?: string;
  /** Dynamic route params, for useParams. */
  params?: Record<string, string>;
}

export const RouteContext = createContext<RouteInfo>({ locale: "zh", pathname: "/" });

export const useRoute = () => useContext(RouteContext);

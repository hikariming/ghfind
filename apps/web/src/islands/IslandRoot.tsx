import type { ReactNode } from "react";
import { IntlProvider, type AbstractIntlMessages } from "use-intl";
import { RouteContext, type RouteInfo } from "../shims/route-context";

/**
 * Serializable props every island receives from the Astro page: the route and
 * only the message namespaces the island uses (not the whole ~90KB bundle).
 */
export interface IslandIntl extends RouteInfo {
  messages: AbstractIntlMessages;
}

export function IslandRoot({ intl, children }: { intl: IslandIntl; children: ReactNode }) {
  return (
    <RouteContext.Provider value={{ locale: intl.locale, pathname: intl.pathname }}>
      <IntlProvider locale={intl.locale} messages={intl.messages} timeZone="UTC">
        {children}
      </IntlProvider>
    </RouteContext.Provider>
  );
}

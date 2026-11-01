import { useTranslations } from "next-intl";
import { IntegrationsView } from "@/components/pages/IntegrationsView";
import { IslandRoot } from "./IslandRoot";
import type { WithIntl } from "./types";

function IntegrationsBody(props: Omit<React.ComponentProps<typeof IntegrationsView>, "t">) {
  return <IntegrationsView {...props} t={useTranslations("integrations")} />;
}

export function IntegrationsPageIsland({ intl, ...props }: WithIntl<Omit<React.ComponentProps<typeof IntegrationsView>, "t">>) {
  return <IslandRoot intl={intl}><IntegrationsBody {...props} /></IslandRoot>;
}

import { useTranslations } from "next-intl";
import { VsIndexView } from "@/components/pages/VsIndexView";
import { IslandRoot } from "./IslandRoot";
import type { WithIntl, WithoutT } from "./types";

function VsIndexBody(props: WithoutT<typeof VsIndexView>) {
  return <VsIndexView {...props} t={useTranslations("vs")} />;
}

export function VsIndexIsland({ intl, ...props }: WithIntl<WithoutT<typeof VsIndexView>>) {
  return <IslandRoot intl={intl}><VsIndexBody {...props} /></IslandRoot>;
}

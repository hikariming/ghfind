import { useTranslations } from "next-intl";
import { ProfileView } from "@/components/pages/ProfileView";
import { ProfileReactions } from "@/components/ProfileReactions";
import type { ProfileReactionState } from "@/lib/reactions";
import { IslandRoot } from "./IslandRoot";
import type { WithIntl, WithoutT } from "./types";

type Props = Omit<WithoutT<typeof ProfileView>, "tDim" | "tTier" | "tRealm" | "reactions"> & {
  /** Preloaded state for the reactions block (the Next page streams it instead). */
  reactions: {
    authenticated: boolean;
    authAvailable: boolean;
    initialState: ProfileReactionState;
    signInCallbackUrl: string;
  };
};

function ProfileBody({ reactions, ...props }: Props) {
  const d = props.presentation.detail;
  return (
    <ProfileView
      {...props}
      reactions={<ProfileReactions key={`reactions-${d.username}`} profileUsername={d.username} flat={props.isAdvxCampaign} {...reactions} />}
      t={useTranslations("detail")}
      tDim={useTranslations("dimensions")}
      tTier={useTranslations("tiers")}
      tRealm={useTranslations("realms")}
    />
  );
}

export function ProfileIsland({ intl, ...props }: WithIntl<Props>) {
  return <IslandRoot intl={intl}><ProfileBody {...props} /></IslandRoot>;
}

/**
 * Server-only React entry points for page bodies shared with the Next app
 * (`src/components/pages`). Astro renders these to HTML without hydrating
 * them (no `client:*` directive), so they ship no JS; interactive pieces such
 * as comment bubbles are separate islands. The RouteContext lets the shared
 * `Link` (navigation shim) build locale-prefixed hrefs during SSR.
 */
import type { ComponentProps, ReactNode } from "react";
import type { Locale } from "@ghfind/i18n";
import { BlogIndexView, BlogPostView } from "@/components/pages/BlogViews";
import { CollectionsIndexView, CollectionView } from "@/components/pages/CollectionViews";
import { ContactView } from "@/components/pages/ContactView";
import { PrivacyView } from "@/components/pages/PrivacyView";
import { MethodologyView } from "@/components/pages/MethodologyView";
import { DocsView } from "@/components/pages/DocsView";
import { GithubBotView } from "@/components/pages/GithubBotView";
import { DevelopersIndexView } from "@/components/pages/DevelopersIndexView";
import { HomeView } from "@/components/pages/HomeView";
import { JobsView } from "@/components/pages/JobsView";
import { RouteContext } from "../shims/route-context";

function Route({ locale, path, children }: { locale: Locale; path: string; children: ReactNode }) {
  return <RouteContext.Provider value={{ locale, pathname: path }}>{children}</RouteContext.Provider>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- any component
type Routed<V extends (props: any) => ReactNode> = ComponentProps<V> & { route: { locale: Locale; path: string } };

export function BlogIndex({ route, ...props }: Routed<typeof BlogIndexView>) {
  return <Route {...route}><BlogIndexView {...props} /></Route>;
}

export function BlogPost({ route, ...props }: Routed<typeof BlogPostView>) {
  return <Route {...route}><BlogPostView {...props} /></Route>;
}

export function CollectionsIndex({ route, ...props }: Routed<typeof CollectionsIndexView>) {
  return <Route {...route}><CollectionsIndexView {...props} /></Route>;
}

export function CollectionPage({ route, ...props }: Routed<typeof CollectionView>) {
  return <Route {...route}><CollectionView {...props} /></Route>;
}

export function Contact({ route, ...props }: Routed<typeof ContactView>) {
  return <Route {...route}><ContactView {...props} /></Route>;
}

export function Privacy({ route, ...props }: Routed<typeof PrivacyView>) {
  return <Route {...route}><PrivacyView {...props} /></Route>;
}

export function Methodology({ route, ...props }: Routed<typeof MethodologyView>) {
  return <Route {...route}><MethodologyView {...props} /></Route>;
}

export function Docs({ route, ...props }: Routed<typeof DocsView>) {
  return <Route {...route}><DocsView {...props} /></Route>;
}

export function GithubBot({ route, ...props }: Routed<typeof GithubBotView>) {
  return <Route {...route}><GithubBotView {...props} /></Route>;
}

export function DevelopersIndex({ route, ...props }: Routed<typeof DevelopersIndexView>) {
  return <Route {...route}><DevelopersIndexView {...props} /></Route>;
}

export function Jobs({ route, ...props }: Routed<typeof JobsView>) {
  return <Route {...route}><JobsView {...props} /></Route>;
}

type HomeSlots = "roaster" | "developerCount" | "sponsorRow" | "collections" | "leaderboardRail";

/**
 * The homepage with its interactive pieces as Astro named slots: Astro hands
 * each slot to the component as a prop (static HTML wrapping an island), so
 * every island hydrates independently inside the static page.
 */
export function Home({ route, ...props }: Omit<Routed<typeof HomeView>, HomeSlots> & Partial<Pick<Routed<typeof HomeView>, HomeSlots>>) {
  return (
    <Route {...route}>
      <HomeView
        {...props}
        roaster={props.roaster}
        developerCount={props.developerCount}
        sponsorRow={props.sponsorRow}
        collections={props.collections}
        leaderboardRail={props.leaderboardRail}
      />
    </Route>
  );
}

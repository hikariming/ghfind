import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { ProfileView } from "../src/components/pages/ProfileView";

const t = (key: string, values?: Record<string, unknown>) => {
  if (values && "count" in values) return `${key}:${values.count}`;
  if (values && "share" in values) return `${key}:${values.share}`;
  return key;
};

const presentation = {
  detail: {
    username: "preview-user",
    display_name: "Preview",
    avatar_url: null,
    profile_url: "https://github.com/preview-user",
    final_score: 82.9,
    tier: "顶级",
    tags: { zh: [], en: [] },
    sub_scores: {
      originality: 15,
      influence: 15,
      activity: 15,
      collaboration: 15,
      consistency: 15,
      community: 8,
    },
    scanned_at: "2026-01-01T00:00:00Z",
    score_version: "v17",
    score_source_collection_version: null,
    score_source_snapshot_hash: null,
    score_breakdown: null,
  },
  snap: {
    impact_repos: [
      { repo: "org-alpha/flagship", stars: 160000, commits: 3, prs: 3 },
      { repo: "org-beta/toolkit", stars: 12000, commits: 1, prs: 1 },
    ],
    top_repos: [],
    pinned_repos: [],
    signature_work: null,
    organizations: [],
    bio: "hello",
    company: null,
  },
  similar: [],
  commonProjects: [],
  existing_repo_keys: [],
  beat: 90,
  isOwner: false,
  autoRescan: false,
};

try {
  const html = renderToStaticMarkup(
    createElement(ProfileView, {
      locale: "zh",
      presentation: presentation as never,
      isAdvxCampaign: false,
      fromHome: false,
      refParam: undefined,
      referer: null,
      viewerLogin: null,
      comments: { items: [], total: 0 } as never,
      staleReroast: false,
      shouldStreamRoast: false,
      liveScan: null,
      reactions: null,
      t,
      tDim: t,
      tTier: t,
    }),
  );
  console.log("OK len", html.length);
  console.log("orbit", html.includes("impact-orbit-root"));
  console.log("disclosure", html.includes("impactDisclosure"));
} catch (e) {
  console.error("FAIL", e);
  process.exit(1);
}

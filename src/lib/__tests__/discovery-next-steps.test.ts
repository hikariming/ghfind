import { describe, expect, it } from "vitest";
import {
  commonProjectRows,
  discoveryNextStepCards,
  relatedProjectRows,
} from "../discovery-next-steps";
import type { ProjectListItem, RelatedProject } from "../db";

const project = (key: string): ProjectListItem => ({
  repo: {
    repo_key: key,
    name_with_owner: key,
    owner_login: key.split("/")[0],
    name: key.split("/")[1],
    description: `${key} description`,
    stars: 100,
    forks: null,
    language: "TypeScript",
    topics: [],
  },
  contributorCount: 2,
  avgScore: 90,
  eliteCount: 1,
  momentum: 3,
  qualityScore: 140,
  topContributors: [],
});

describe("discovery next-step models", () => {
  it("maps related projects and exposes why they are related", () => {
    const related: RelatedProject[] = [
      { project: project("acme/related"), sharedContributorCount: 2 },
      { project: project("acme/language-peer"), sharedContributorCount: 0 },
    ];
    expect(relatedProjectRows(related)).toEqual([
      expect.objectContaining({
        href: "/developers/repo/acme/related",
        sharedContributorCount: 2,
        relation: "shared",
      }),
      expect.objectContaining({ relation: "language" }),
    ]);
  });

  it("maps common projects and hides empty inputs", () => {
    expect(commonProjectRows([])).toEqual([]);
    expect(commonProjectRows([project("acme/common")])[0]).toMatchObject({
      title: "acme/common",
      href: "/developers/repo/acme/common",
    });
  });

  it("provides stable project and organization exits from the leaderboard", () => {
    expect(discoveryNextStepCards()).toEqual([
      { kind: "projects", href: "/projects/discovery" },
      { kind: "organizations", href: "/developers#organizations" },
    ]);
  });
});

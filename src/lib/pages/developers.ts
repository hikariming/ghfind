import { getGoFacetCategories } from "@/lib/go-developers.server";

/** Data for the /developers directory, shared by the Next page and apps/web. */
export async function loadDevelopersIndex() {
  const [languages, orgs, projectsAll] = await Promise.all([
    getGoFacetCategories("language"),
    getGoFacetCategories("org"),
    getGoFacetCategories("repo"),
  ]);
  // The repo axis has far more buckets (one per notable project) than languages
  // or orgs, and they're already ordered most-contributors-first — show only the
  // busiest head so the grid stays scannable instead of a wall of 100 pills.
  const projects = projectsAll.slice(0, 48);
  return { languages, orgs, projects };
}

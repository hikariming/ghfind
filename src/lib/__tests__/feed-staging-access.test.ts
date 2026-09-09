import { afterEach, describe, expect, it, vi } from "vitest";
import { authorizeStagingAssessment } from "../feed-staging-access";

const session = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock("../auth", () => ({ auth: session.read }));
afterEach(() => { vi.unstubAllEnvs(); vi.resetAllMocks(); });

function configured() {
  vi.stubEnv("GHFIND_DEPLOY_ENV", "feed-staging");
  vi.stubEnv("FEED_STAGING_ALLOWED_GITHUB_IDS", "101,102");
  vi.stubEnv("FEED_STAGING_ALLOWED_REPOSITORIES", "example/tool");
  session.read.mockResolvedValue({ user: { githubId: 101, login: "test-account" } });
}

describe("isolated staging assessment admission", () => {
  it("preserves ordinary production behavior without accessing OAuth", async () => {
    vi.stubEnv("GHFIND_DEPLOY_ENV", "production");
    vi.stubEnv("PUBLIC_SITE_URL", "https://ghfind.com");
    expect(await authorizeStagingAssessment("any/repo", "any-ref")).toBeNull();
    expect(session.read).not.toHaveBeenCalled();
  });
  it("accepts only a real authenticated allowlisted identity and canonical approved repo", async () => {
    configured();
    expect(await authorizeStagingAssessment("https://github.com/example/tool")).toBeNull();
    session.read.mockResolvedValue(null);
    expect((await authorizeStagingAssessment("example/tool"))?.status).toBe(401);
    session.read.mockResolvedValue({ user: { githubId: 999, login: "outsider" } });
    expect((await authorizeStagingAssessment("example/tool"))?.status).toBe(403);
  });
  it("rejects unapproved repos and arbitrary refs before external provider work", async () => {
    configured();
    expect((await authorizeStagingAssessment("another/tool"))?.status).toBe(403);
    expect((await authorizeStagingAssessment("https://evil.test/example/tool"))?.status).toBe(400);
    expect((await authorizeStagingAssessment("example/tool", "new-expensive-ref"))?.status).toBe(403);
  });
  it.each(["", "101", "101,101", "101,102,103", "101,9007199254740992"])("fails closed for malformed identities %s", async ids => {
    configured();
    vi.stubEnv("FEED_STAGING_ALLOWED_GITHUB_IDS", ids);
    expect((await authorizeStagingAssessment("example/tool"))?.status).toBe(503);
    expect(session.read).not.toHaveBeenCalled();
  });
  it("fails closed when the staging origin lacks its explicit deployment marker", async () => {
    configured();
    vi.stubEnv("GHFIND_DEPLOY_ENV", "preview");
    vi.stubEnv("PUBLIC_SITE_URL", "https://ghfind-feed-web-staging.beiming1201.workers.dev");
    expect((await authorizeStagingAssessment("example/tool"))?.status).toBe(503);
  });
});

import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { emptyReactionCounts } from "../../../../lib/reactions";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  authConfigured: vi.fn(() => true),
  removeProfileReaction: vi.fn(),
  setProfileReaction: vi.fn(),
}));

vi.mock("../../../../lib/auth", () => ({
  auth: mocks.auth,
  authConfigured: mocks.authConfigured,
}));

vi.mock("../../../../lib/db", () => ({
  removeProfileReaction: mocks.removeProfileReaction,
  setProfileReaction: mocks.setProfileReaction,
}));

import { DELETE, PUT } from "./route";

const context = { params: Promise.resolve({ username: "Tiann" }) };
const state = {
  counts: { ...emptyReactionCounts(), fire: 1 },
  viewerReaction: "fire" as const,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.authConfigured.mockReturnValue(true);
  mocks.auth.mockResolvedValue({ user: { githubId: 42, login: "voter" } });
  mocks.setProfileReaction.mockResolvedValue(state);
  mocks.removeProfileReaction.mockResolvedValue({
    counts: emptyReactionCounts(),
    viewerReaction: null,
  });
});

describe("profile reaction API", () => {
  it("requires a GitHub session", async () => {
    mocks.auth.mockResolvedValue(null);
    const response = await PUT(
      new NextRequest("https://example.test/api/profile-reactions/tiann", {
        method: "PUT",
        body: JSON.stringify({ reaction: "fire" }),
      }),
      context,
    );

    expect(response.status).toBe(401);
    expect(mocks.setProfileReaction).not.toHaveBeenCalled();
  });

  it("rejects reactions outside the allowlist", async () => {
    const response = await PUT(
      new NextRequest("https://example.test/api/profile-reactions/tiann", {
        method: "PUT",
        body: JSON.stringify({ reaction: "heart" }),
      }),
      context,
    );

    expect(response.status).toBe(400);
  });

  it("stores a reaction using identity from the server session", async () => {
    const response = await PUT(
      new NextRequest("https://example.test/api/profile-reactions/tiann", {
        method: "PUT",
        body: JSON.stringify({ reaction: "fire", voterGithubId: 999 }),
      }),
      context,
    );

    expect(response.status).toBe(200);
    expect(mocks.setProfileReaction).toHaveBeenCalledWith({
      targetUsername: "tiann",
      voterGithubId: 42,
      voterLogin: "voter",
      reaction: "fire",
    });
    await expect(response.json()).resolves.toEqual(state);
  });

  it("removes only the current GitHub user's reaction", async () => {
    const response = await DELETE(
      new NextRequest("https://example.test/api/profile-reactions/tiann", { method: "DELETE" }),
      context,
    );

    expect(response.status).toBe(200);
    expect(mocks.removeProfileReaction).toHaveBeenCalledWith({
      targetUsername: "tiann",
      voterGithubId: 42,
    });
  });

  it("reports unavailable persistence without pretending the vote succeeded", async () => {
    mocks.setProfileReaction.mockResolvedValue(null);
    const response = await PUT(
      new NextRequest("https://example.test/api/profile-reactions/tiann", {
        method: "PUT",
        body: JSON.stringify({ reaction: "fire" }),
      }),
      context,
    );

    expect(response.status).toBe(503);
  });
});

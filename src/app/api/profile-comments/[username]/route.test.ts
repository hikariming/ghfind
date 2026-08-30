import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProfileCommentAuthor } from "../../../../lib/comments";

interface CreateProfileCommentInput {
  targetUsername: string;
  text: string;
  author: ProfileCommentAuthor;
  authorGithubId?: number;
}

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  authConfigured: vi.fn(() => true),
  createProfileComment: vi.fn(),
  getProfileComments: vi.fn(),
}));

vi.mock("../../../../lib/auth", () => ({
  auth: mocks.auth,
  authConfigured: mocks.authConfigured,
}));

vi.mock("../../../../lib/db", () => ({
  createProfileComment: mocks.createProfileComment,
  getProfileComments: mocks.getProfileComments,
}));

import { POST } from "./route";

const context = { params: Promise.resolve({ username: "Tiann" }) };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.authConfigured.mockReturnValue(true);
  mocks.auth.mockResolvedValue({
    user: {
      githubId: 42,
      image: "https://avatars.githubusercontent.com/u/42",
      login: "Commenter",
    },
  });
  mocks.createProfileComment.mockImplementation(async (input: CreateProfileCommentInput) => ({
    id: "comment-1",
    targetUsername: input.targetUsername,
    author: input.author,
    text: input.text,
    createdAt: 1_700_000_000_000,
  }));
});

describe("profile comments API", () => {
  it("stores non-anonymous comments by default using the viewer GitHub identity", async () => {
    const response = await POST(
      new NextRequest("https://example.test/api/profile-comments/tiann", {
        method: "POST",
        body: JSON.stringify({ text: "说得太狠了" }),
      }),
      context,
    );

    expect(response.status).toBe(201);
    expect(mocks.createProfileComment).toHaveBeenCalledWith({
      targetUsername: "tiann",
      text: "说得太狠了",
      author: {
        type: "github",
        username: "commenter",
        avatarUrl: "https://avatars.githubusercontent.com/u/42",
      },
      authorGithubId: 42,
    });
  });

  it("stores anonymous comments only when anonymous is explicitly selected", async () => {
    const response = await POST(
      new NextRequest("https://example.test/api/profile-comments/tiann", {
        method: "POST",
        body: JSON.stringify({ anonymous: true, text: "匿名围观" }),
      }),
      context,
    );

    expect(response.status).toBe(201);
    expect(mocks.auth).not.toHaveBeenCalled();
    expect(mocks.createProfileComment).toHaveBeenCalledWith({
      targetUsername: "tiann",
      text: "匿名围观",
      author: { type: "anonymous" },
      authorGithubId: undefined,
    });
  });

  it("does not silently downgrade a non-anonymous comment to anonymous", async () => {
    mocks.auth.mockResolvedValue(null);

    const response = await POST(
      new NextRequest("https://example.test/api/profile-comments/tiann", {
        method: "POST",
        body: JSON.stringify({ anonymous: false, text: "我要署名" }),
      }),
      context,
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "authentication_required" });
    expect(mocks.createProfileComment).not.toHaveBeenCalled();
  });
});

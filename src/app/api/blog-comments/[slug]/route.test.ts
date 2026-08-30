import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CommentAuthor } from "@/lib/comments";

interface CreateBlogCommentInput {
  postSlug: string;
  text: string;
  author: CommentAuthor;
  authorGithubId?: number;
}

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  authConfigured: vi.fn(() => true),
  createBlogComment: vi.fn(),
  getBlogComments: vi.fn(),
  getPost: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  auth: mocks.auth,
  authConfigured: mocks.authConfigured,
}));

vi.mock("@/lib/blog", () => ({
  getPost: mocks.getPost,
}));

vi.mock("@/lib/db", () => ({
  createBlogComment: mocks.createBlogComment,
  getBlogComments: mocks.getBlogComments,
}));

import { GET, POST } from "./route";

const context = { params: Promise.resolve({ slug: "how-we-score-github-accounts" }) };

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
  mocks.getPost.mockReturnValue({ slug: "how-we-score-github-accounts" });
  mocks.getBlogComments.mockResolvedValue([]);
  mocks.createBlogComment.mockImplementation(async (input: CreateBlogCommentInput) => ({
    id: "comment-1",
    postSlug: input.postSlug,
    author: input.author,
    text: input.text,
    createdAt: 1_700_000_000_000,
  }));
});

describe("blog comments API", () => {
  it("returns the latest visible comments for an existing post", async () => {
    mocks.getBlogComments.mockResolvedValue([
      {
        id: "comment-1",
        postSlug: "how-we-score-github-accounts",
        author: { type: "anonymous" },
        text: "围观",
        createdAt: 1_700_000_000_000,
      },
    ]);

    const response = await GET(
      new NextRequest("https://example.test/api/blog-comments/how-we-score-github-accounts"),
      context,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      comments: [
        expect.objectContaining({ text: "围观", author: { type: "anonymous" } }),
      ],
    });
    expect(mocks.getBlogComments).toHaveBeenCalledWith("how-we-score-github-accounts");
  });

  it("stores non-anonymous comments with the viewer GitHub identity", async () => {
    const response = await POST(
      new NextRequest("https://example.test/api/blog-comments/how-we-score-github-accounts", {
        method: "POST",
        body: JSON.stringify({ text: "这个分析很有帮助" }),
      }),
      context,
    );

    expect(response.status).toBe(201);
    expect(mocks.createBlogComment).toHaveBeenCalledWith({
      postSlug: "how-we-score-github-accounts",
      text: "这个分析很有帮助",
      author: {
        type: "github",
        username: "commenter",
        avatarUrl: "https://avatars.githubusercontent.com/u/42",
      },
      authorGithubId: 42,
    });
  });

  it("allows anonymous comments without attempting GitHub authentication", async () => {
    const response = await POST(
      new NextRequest("https://example.test/api/blog-comments/how-we-score-github-accounts", {
        method: "POST",
        body: JSON.stringify({ anonymous: true, text: "匿名围观" }),
      }),
      context,
    );

    expect(response.status).toBe(201);
    expect(mocks.auth).not.toHaveBeenCalled();
    expect(mocks.createBlogComment).toHaveBeenCalledWith({
      postSlug: "how-we-score-github-accounts",
      text: "匿名围观",
      author: { type: "anonymous" },
      authorGithubId: undefined,
    });
  });

  it("does not silently downgrade an unsigned comment to anonymous", async () => {
    mocks.auth.mockResolvedValue(null);

    const response = await POST(
      new NextRequest("https://example.test/api/blog-comments/how-we-score-github-accounts", {
        method: "POST",
        body: JSON.stringify({ anonymous: false, text: "我要署名" }),
      }),
      context,
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "authentication_required" });
    expect(mocks.createBlogComment).not.toHaveBeenCalled();
  });

  it("rejects comments for a post that does not exist", async () => {
    mocks.getPost.mockReturnValue(null);
    const missingPostContext = { params: Promise.resolve({ slug: "missing-post" }) };

    const response = await POST(
      new NextRequest("https://example.test/api/blog-comments/missing-post", {
        method: "POST",
        body: JSON.stringify({ anonymous: true, text: "不应保存" }),
      }),
      missingPostContext,
    );

    expect(response.status).toBe(404);
    expect(mocks.createBlogComment).not.toHaveBeenCalled();
  });

  it("rejects a malformed encoded post slug", async () => {
    const malformedContext = { params: Promise.resolve({ slug: "%" }) };

    const response = await GET(
      new NextRequest("https://example.test/api/blog-comments/%"),
      malformedContext,
    );

    expect(response.status).toBe(404);
    expect(mocks.getBlogComments).not.toHaveBeenCalled();
  });
});

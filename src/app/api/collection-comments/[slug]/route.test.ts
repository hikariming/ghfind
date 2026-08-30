import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CommentAuthor } from "@/lib/comments";

interface CreateCollectionCommentInput {
  collectionSlug: string;
  text: string;
  author: CommentAuthor;
  authorGithubId?: number;
}

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  authConfigured: vi.fn(() => true),
  createCollectionComment: vi.fn(),
  getCollectionComments: vi.fn(),
  getCollection: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  auth: mocks.auth,
  authConfigured: mocks.authConfigured,
}));

vi.mock("@/lib/collections", () => ({
  getCollection: mocks.getCollection,
}));

vi.mock("@/lib/db", () => ({
  createCollectionComment: mocks.createCollectionComment,
  getCollectionComments: mocks.getCollectionComments,
}));

import { GET, POST } from "./route";

const context = { params: Promise.resolve({ slug: "lofisu" }) };

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
  mocks.getCollection.mockReturnValue({ slug: "lofisu" });
  mocks.getCollectionComments.mockResolvedValue([]);
  mocks.createCollectionComment.mockImplementation(
    async (input: CreateCollectionCommentInput) => ({
      id: "comment-1",
      collectionSlug: input.collectionSlug,
      author: input.author,
      text: input.text,
      createdAt: 1_700_000_000_000,
    }),
  );
});

describe("collection comments API", () => {
  it("returns the latest visible comments for an existing collection", async () => {
    mocks.getCollectionComments.mockResolvedValue([
      {
        id: "comment-1",
        collectionSlug: "lofisu",
        author: { type: "anonymous" },
        text: "围观",
        createdAt: 1_700_000_000_000,
      },
    ]);

    const response = await GET(
      new NextRequest("https://example.test/api/collection-comments/lofisu"),
      context,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      comments: [
        expect.objectContaining({ text: "围观", author: { type: "anonymous" } }),
      ],
    });
    expect(mocks.getCollectionComments).toHaveBeenCalledWith("lofisu");
  });

  it("stores non-anonymous comments with the viewer GitHub identity", async () => {
    const response = await POST(
      new NextRequest("https://example.test/api/collection-comments/lofisu", {
        method: "POST",
        body: JSON.stringify({ text: "这个合集很有帮助" }),
      }),
      context,
    );

    expect(response.status).toBe(201);
    expect(mocks.createCollectionComment).toHaveBeenCalledWith({
      collectionSlug: "lofisu",
      text: "这个合集很有帮助",
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
      new NextRequest("https://example.test/api/collection-comments/lofisu", {
        method: "POST",
        body: JSON.stringify({ anonymous: true, text: "匿名围观" }),
      }),
      context,
    );

    expect(response.status).toBe(201);
    expect(mocks.auth).not.toHaveBeenCalled();
    expect(mocks.createCollectionComment).toHaveBeenCalledWith({
      collectionSlug: "lofisu",
      text: "匿名围观",
      author: { type: "anonymous" },
      authorGithubId: undefined,
    });
  });

  it("does not silently downgrade an unsigned comment to anonymous", async () => {
    mocks.auth.mockResolvedValue(null);

    const response = await POST(
      new NextRequest("https://example.test/api/collection-comments/lofisu", {
        method: "POST",
        body: JSON.stringify({ anonymous: false, text: "我要署名" }),
      }),
      context,
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "authentication_required" });
    expect(mocks.createCollectionComment).not.toHaveBeenCalled();
  });

  it("rejects comments for a collection that does not exist", async () => {
    mocks.getCollection.mockReturnValue(null);
    const missingCollectionContext = { params: Promise.resolve({ slug: "missing-collection" }) };

    const response = await POST(
      new NextRequest("https://example.test/api/collection-comments/missing-collection", {
        method: "POST",
        body: JSON.stringify({ anonymous: true, text: "不应保存" }),
      }),
      missingCollectionContext,
    );

    expect(response.status).toBe(404);
    expect(mocks.createCollectionComment).not.toHaveBeenCalled();
  });

  it("rejects a malformed encoded collection slug", async () => {
    const malformedContext = { params: Promise.resolve({ slug: "%" }) };

    const response = await GET(
      new NextRequest("https://example.test/api/collection-comments/%"),
      malformedContext,
    );

    expect(response.status).toBe(404);
    expect(mocks.getCollectionComments).not.toHaveBeenCalled();
  });
});
